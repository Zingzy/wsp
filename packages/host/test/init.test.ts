// SPDX-License-Identifier: AGPL-3.0-only
// wsp init end to end against the stub backend: keys in, the three screens,
// the summary and confirm, prepare with its stage stream, the sign-ins and
// secrets, the seal, the first workspace and the app's address. The runtime
// and host are the real ones over fakes; only the terminal is faked.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { RUNGS, parseManifest, type Manifest, type ManifestEntry } from "@wsp/collect";
import { SNAPSHOT_STORAGE, type BackendPricing } from "@wsp/engine";
import { ALREADY_APPLIED, Recipe, type GoldenManifest, type ProjectImportResult, type ProjectPlan } from "@wsp/protocol";
import { DAEMON_TOKEN_SET, createRuntime, goldenHead, memoryStore, type GoldenRecipe, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SETUP, catalogEntry } from "@wsp/catalog";
import { applyRecipe, recipePath, withCatalogAgents } from "../src/init-recipe.js";
import { signInItems } from "../src/init-pick.js";
import { CARD_FRAME, card, widthOf } from "../src/init-layout.js";
import { PROJECT_QUESTION, noFolderNote } from "../src/init-pick.js";
import { reduceStages, runInit, stageLine, summaryNote, type HostHooks, type InitIO, type InitOptions } from "../src/init.js";
import { FIRST_QUESTION, FOLDER_QUESTION } from "../src/init-first.js";
import type { HostHandle } from "../src/server.js";
import { startCallbackRelay } from "../src/relay.js";
import type { ConnectOptions, DaemonSocket } from "../src/doctor.js";
import { appendCommand, readCommand } from "../src/init-secrets.js";
import { importResultPath } from "../src/init-import.js";
import { noteOutcomes } from "../src/init-signin.js";
import { fakePtyLink, type FakePtyLink } from "./fake-pty-link.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";
import { guestAnswer, stubBackend, type StubBackend, type StubMachine } from "./stub-backend.js";

const SOLARI = "slr_live_fake_solari_key";
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", space: " ", enter: "\r", esc: "\x1b", ctrlC: "\x03" };
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\//;
const SEAL_Q = (v: number) => `Seal this machine as golden v${v}?`;
const BOOT = /Boot a \d+ vCPU/;
const PRICING: BackendPricing = { rateUsdPerHour: s => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE };

/** A folder as the host would plan it: one secret-shaped file that must be cut, one the plan offers a rewrite for,
 * one agent with sessions and one without. What the wizard consents to out of this is the app's own default. */
const PLAN: Omit<ProjectPlan, "source"> = {
  repo: true,
  files: 12,
  bytes: 3072,
  secrets: [
    { path: ".env", bytes: 120, signals: ["keys"] },
    { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/o/r"], drop: [] } },
  ],
  excluded: ["node_modules"],
  skipped: [],
  agents: [
    { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" },
    { agent: "gemini", name: "Gemini CLI", sessions: 0, bytes: 0, carry: "moves" },
  ],
};

interface Fake {
  io: InitIO;
  opts: InitOptions;
  text(): string;
  raw(): string;
  clear(): void;
  press(...keys: string[]): Promise<void>;
  until(needle: string | RegExp, ms?: number): Promise<void>;
  opened: string[];
  backends: StubBackend[];
  recipes: GoldenRecipe[];
  runtimes: Runtime[];
  hooks: HostHooks[];
  /** The scripted daemon link the sign-in stage talks to. */
  link: FakePtyLink;
  hosts: number;
  /** How many host handles were closed by the run. */
  hostsClosed: number;
  /** Keychain services the fake reader was asked for. */
  reads: string[];
  /** Where a test delivers Ctrl-C; the real one is process. */
  signals: EventEmitter;
  /** Exit codes the run asked for, in order; the real one ends the process. */
  exits: number[];
  /** What the end of the run did, in order: the fork, the import and the address the app opened on. */
  trail: string[];
  /** Every import the run asked for, as it asked for it. */
  imports: { workspaceId: string; source: string; dest: string; carry?: readonly string[]; rewrite?: readonly string[]; agents?: readonly string[] }[];
  /** The objects --json printed, in order. */
  records: Record<string, unknown>[];
}

const DEVICE_URL = "https://github.com/login/device";
const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

/** The saved manifest as the next run reads it. */
const loadManifest = (path: string): Manifest => parseManifest(JSON.parse(readFileSync(path, "utf8")));
/** The small recipe with these catalog ids ticked on top of RECIPE's own, a row added for one RECIPE has none for. */
const ticking = (...ids: string[]): Recipe => ({
  ...RECIPE,
  rows: [
    ...RECIPE.rows.map(r => (ids.includes(r.id) ? { ...r, on: true } : r)),
    ...ids.filter(id => !RECIPE.rows.some(r => r.id === id)).map((id): Recipe["rows"][number] => ({ id, kind: catalogEntry(id)!.kind, on: true, source: { kind: "popular", sessions: 0, images: 0 } })),
  ],
});
/** The small recipe with these catalog ids off. */
const without = (recipe: Recipe, ...ids: string[]): Recipe => ({ ...recipe, rows: recipe.rows.map(r => (ids.includes(r.id) ? { ...r, on: false } : r)) });
/** The small recipe with a login answered copy: under --yes a saved answer is kept, where the default would sign in on the machine. */
const answeredCopy = (id: string, recipe: Recipe = RECIPE): Recipe => ({ ...recipe, rows: recipe.rows.map(r => (r.id === id ? { ...r, signIn: "copy" } : r)) });

/** Ptys on the fake builder: a login prints its page's URL and exits (or waits for Ctrl-C when held). */
function scriptedLink(state: { signedIn: boolean; hold: boolean; missing: boolean }): FakePtyLink {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    // The secrets step's quiet runs: nothing set on the machine yet, no fish.
    if (line.includes("WSP_STATUS")) {
      link.data(pty, "\r\nWSP_STATUS 0\r\n");
      link.exit(pty, 0);
      return;
    }
    if (state.missing && line.startsWith("exec ")) {
      link.data(pty, `bash: exec: ${line.split(" ")[1]}: not found\r\n`);
      link.exit(pty, 127);
      return;
    }
    if (line.includes("exec claude")) link.data(pty, `Opening browser to sign in...\r\nIf the browser didn't open, visit: \x1b]8;;${CLAUDE_URL}\x1b\\${CLAUDE_URL}\x1b]8;;\x1b\\\r\nPaste code here if prompted > `);
    else link.data(pty, `Press Enter to open ${DEVICE_URL} in your browser...\r\n`);
    if (!state.hold) link.exit(pty, state.signedIn ? 0 : 1);
  };
  const op = link.op.bind(link);
  link.op = async (name, extra = {}) => {
    const r = await op(name, extra);
    if (name === "pty.write" && extra["data"] === "\x03") link.exit(link.ptys.find(x => x.id === extra["ptyId"])!, 130);
    return r;
  };
  return link;
}

function fake(over: Partial<InitOptions> & { tty?: boolean; env?: Record<string, string>; columns?: number; signedIn?: boolean; hold?: boolean; missing?: boolean; json?: boolean } = {}): Fake {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = Object.assign(new PassThrough(), { isTTY: over.tty ?? true });
  if (over.columns !== undefined) Object.assign(output, { columns: over.columns });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  stderr.on("data", (c: Buffer) => chunks.push(c.toString()));
  const text = () => stripVTControlCharacters(chunks.join(""));
  const raw = () => chunks.join("");
  const clear = () => void chunks.splice(0);
  const opened: string[] = [];
  const trail: string[] = [];
  const imports: Fake["imports"] = [];
  const backends: StubBackend[] = [];
  const recipes: GoldenRecipe[] = [];
  const runtimes: Runtime[] = [];
  const hooks: HostHooks[] = [];
  const link = scriptedLink({ signedIn: over.signedIn ?? true, hold: over.hold ?? false, missing: over.missing ?? false });
  const counters = { hosts: 0, closed: 0 };
  const signals = new EventEmitter();
  const exits: number[] = [];
  const records: Record<string, unknown>[] = [];
  const io: InitIO = {
    input,
    output,
    stderr,
    isTTY: over.tty ?? true,
    env: over.env ?? {},
    open: async url => {
      opened.push(url);
      trail.push(`open ${url}`);
      return true;
    },
    signals,
    exit: code => {
      exits.push(code);
    },
    ...(over.json === true ? { json: (record: Record<string, unknown>) => records.push(record) } : {}),
  };
  const dir = mkdtempSync(join(tmpdir(), "wsp-init-"));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), "wsp-init-home-"));
  dirs.push(home);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Me\n");
  writeFileSync(join(home, ".zshrc"), "export A=1\n");
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  writeFileSync(join(home, ".ssh", "config"), "Host work\n", { mode: 0o600 });
  const reads: string[] = [];
  const store = memoryStore();
  const { tty: _tty, env: _env, columns: _columns, signedIn: _signedIn, hold: _hold, missing: _missing, json: _json, ...rest } = over;
  const opts: InitOptions = {
    yes: false,
    // The folder was named on the command line, so the first screen's question is not asked; the run that answers it deletes this.
    project: NAMED_PROJECT,
    collect: async () => FIXTURE,
    recipe: async () => RECIPE,
    scanProject: async folder => ({ dir: folder, rows: [], candidates: [] }),
    keys: { solari: SOLARI },
    pricing: PRICING,
    statePath: join(dir, "state.json"),
    home,
    platform: "darwin",
    secrets: {
      read: async (service, account) => {
        reads.push(account === undefined ? service : `${service} (${account})`);
        return "gho_fake";
      },
      run: async command => {
        reads.push(command);
        return "sk-ant-x-helper\n";
      },
    },
    // One account and one state file per fake, as the cli has: a runtime rebuilt after a Keychain refusal sees the same machines.
    runtime: recipe => {
      recipes.push(recipe);
      const backend = backends[0] ?? stubBackend();
      if (backends.length === 0) backends.push(backend);
      const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      runtimes.push(rt);
      return rt;
    },
    host: async (rt: Runtime, builder, h) => {
      counters.hosts += 1;
      expect(builder.id).toBe(backends.at(-1)?.machines.find(m => !m.killed && m.spec.labels?.["wsp-builder"] === "1")?.id);
      hooks.push(h);
      const handle: HostHandle = { port: 4400, wsPort: 4410, authToken: "tok", createWorkspace: name => { trail.push(`fork ${name}`); return forkHead(rt, name); }, ...fakeProjects(trail, imports), close: async () => void (counters.closed += 1) };
      return handle;
    },
    daemon: async () => ({ link: link.dial(), close: () => {} }),
    retry: { waitMs: 1, attempts: 3 },
    ...rest,
  };
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      input.write(k);
      await new Promise(r => setTimeout(r, k === KEY.esc ? 70 : 5));
    }
  };
  const until = async (needle: string | RegExp, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const t = text();
      if (typeof needle === "string" ? t.includes(needle) : needle.test(t)) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`never saw ${String(needle)} in:\n${text()}`);
  };
  return {
    io,
    opts,
    text,
    raw,
    clear,
    press,
    until,
    opened,
    backends,
    recipes,
    runtimes,
    hooks,
    link,
    get hosts() {
      return counters.hosts;
    },
    get hostsClosed() {
      return counters.closed;
    },
    reads,
    signals,
    exits,
    trail,
    imports,
    records,
  };
}

/** The handle's project roads as a fake: the plan is PLAN at the folder asked for, and the import records what the
 * wizard consented to before answering with what landed. Nothing is read from disk and nothing is packed. */
function fakeProjects(trail: string[], imports: Fake["imports"]): Pick<HostHandle, "planProject" | "importProject"> {
  return {
    planProject: async source => ({ ...PLAN, source }),
    importProject: async o => {
      trail.push(`import ${o.source} -> ${o.dest}`);
      imports.push({ workspaceId: o.workspaceId, source: o.source, dest: o.dest, ...(o.carry !== undefined ? { carry: o.carry } : {}), ...(o.rewrite !== undefined ? { rewrite: o.rewrite } : {}), ...(o.agents !== undefined ? { agents: o.agents } : {}) });
      const result: ProjectImportResult = { dest: o.dest, files: 12, bytes: 3072, parts: 1, cut: [".env"], rewritten: [".git/config"], agents: [{ agent: "claude", files: 40, bytes: 9_400_000, outcome: "moved", sessions: 46, rows: 46 }] };
      return result;
    },
  };
}

/** What the host's own create does: a fork of the golden's head under the given name. */
async function forkHead(rt: Runtime, name: string) {
  const head = goldenHead(await rt.golden.get());
  if (!head) throw new Error("no golden image yet");
  return rt.workspaces.create({ golden: head.snapshotId, name });
}

/** Enter at the seal question: the default answer is yes. */
async function sealIt(f: Fake, version = 1): Promise<void> {
  await f.until(SEAL_Q(version));
  await f.press(KEY.enter);
}

/** The last question answered: false forks nothing, a folder imports it, "" forks the workspace with no project. */
async function firstWorkspace(f: Fake, folder: string | false): Promise<void> {
  await f.until(FIRST_QUESTION);
  if (folder === false) {
    await f.press("n");
    return;
  }
  await f.press(KEY.enter);
  await f.until(FOLDER_QUESTION);
  await f.press(...(folder === "" ? [] : [folder]), KEY.enter);
}

/** A run that ends the way a crash after the boot does: the host never comes up, so the builder stays
 * unsealed and first-life for the next run to find. */
async function bootedOnly(f: Fake): Promise<void> {
  const host = f.opts.host;
  f.opts.host = async (rt, builder, hooks) => {
    await host(rt, builder, hooks);
    throw new Error("host down in this fixture");
  };
  await expect(runInit(f.opts, f.io)).rejects.toThrow("host down in this fixture");
}

/** A host whose first-workspace fork is refused, for runs that test the roads before it. */
const quietHost = () => async (): Promise<HostHandle> => ({ port: 4400, wsPort: 4410, authToken: "tok", createWorkspace: async () => { throw new Error("no workspace in this fixture"); }, ...fakeProjects([], []), close: async () => {} });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The project folder a run names on the command line. */
const NAMED_PROJECT = "/Users/dev/proj";

/** The gh login answered copy in the recipe the run starts from. */
function withGhCopy(f: Fake): void {
  f.opts.recipe = async () => answeredCopy("gh");
}

/** The five screens a run asks before the build, in order. */
const SCREENS = ["Agents", "Tools", "Also on this Mac", "Sign-ins", "wsp for your agents on this Mac"];

/** Enter through every screen, taking the defaults each one opens on. */
async function throughScreens(f: Fake, screens: readonly string[] = SCREENS): Promise<void> {
  for (const screen of screens) {
    await f.until(screen);
    await f.press(KEY.enter);
  }
}

describe("wsp init, interactive", () => {
  it("offers what this Mac's package managers have as its own screen, every row off, and a tick writes that row into the recipe", async () => {
    const f = fake();
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, JSON.stringify({ version: 1, at: "2026-09-06T03:00:00.000Z", histories: [], rows: [], custom: [{ kind: "custom", id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", why: "added by the agent" }] }));
    // The scan is asked with what the recipe already installs, so it can leave those tools off the screen.
    let asked: readonly { id: string }[] = [];
    f.opts.scan = async recipe => {
      asked = recipe;
      return [
        { id: "brew/llvm", name: "llvm", manager: "brew", group: "Homebrew formulae", install: "brew install llvm", check: "command -v llvm", size: 2 * 1024 * 1024 * 1024 },
        { id: "npm/turbo", name: "turbo", manager: "npm", group: "npm globals", install: "npm install -g turbo", check: "command -v turbo" },
      ];
    };
    const run = runInit(f.opts, f.io);
    await throughScreens(f, ["Agents", "Tools"]);
    await f.until("Also on this Mac");
    const screen = f.text().slice(f.text().lastIndexOf("◆  Also on this Mac"));
    // The third of the six screens, its own sentence over it, and every row starts off with its manager's count and weight.
    expect(screen).toMatch(/Also on this Mac\s+3\/6/);
    expect(screen).toContain("We found these installed on this Mac. Tick the ones you or your agents need");
    expect(screen).toMatch(/▾ Homebrew formulae\s+0 of 1\s+0 B\n┃\s+○ llvm\s+2\.0 GB\n/);
    expect(screen).toMatch(/▾ npm globals\s+0 of 1\s+0 B\n┃\s+○ turbo\s+size unknown\n/);
    // The screen that spends disk shows the Disk line, as Tools does, and it follows the ticks.
    const disk = (text: string): string => text.slice(text.lastIndexOf("Disk: ")).split("\n")[0]!;
    const before = disk(screen);
    expect(before).toContain("on the 20 GB builder");
    // Down to llvm, tick it, on to the sign-ins.
    await f.press(KEY.down);
    await f.press(" ");
    await f.until(/● llvm/);
    expect(disk(f.text().slice(f.text().lastIndexOf("◆  Also on this Mac")))).not.toBe(before);
    await f.press(KEY.enter);
    await throughScreens(f, ["Sign-ins", "wsp for your agents on this Mac"]);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
    expect(asked.map(r => r.id)).toEqual(["cuda"]);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")).custom).toEqual([
      { kind: "custom", id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", why: "added by the agent" },
      { kind: "custom", id: "brew/llvm", name: "llvm", install: ["brew install llvm"], check: "command -v llvm", manager: "brew", size: 2 * 1024 * 1024 * 1024, why: "installed on this Mac by brew" },
    ]);
  });

  it("keeps the rows wsp recipe --add wrote into the recipe beside the state, which a plain run rewrites", async () => {
    const f = fake({ yes: true });
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [],
      custom: [{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" }],
    }));
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.backends[0]!.machines[0]!.execLog.some(c => c.includes("brew install just"))).toBe(true);
    expect(JSON.parse(readFileSync(saved, "utf8")).custom).toEqual([
      { kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" },
    ]);
  });

  it("says so and carries on when the recipe beside the state cannot be read, rather than refusing to run", async () => {
    const f = fake({ yes: true });
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, "{ not json");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("added rows go with it");
  });

  it("names Also on this Mac beside What they need when the recipe that overfills the disk has a row from it", async () => {
    const f = fake({ yes: true });
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [],
      custom: [{ kind: "custom", id: "brew/llvm", name: "llvm", install: ["brew install llvm"], check: "command -v llvm", size: 30 * 1024 * 1024 * 1024, why: "installed on this Mac by brew" }],
    }));
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain("This recipe needs about");
    expect(out).toContain("under Tools or Also on this Mac");
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
  });

  it("with no manager row to offer, the third screen keeps its place and says so", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await throughScreens(f, ["Agents", "Tools"]);
    await f.until("Also on this Mac  3/6");
    const screen = f.text().slice(f.text().lastIndexOf("◆  Also on this Mac"));
    expect(screen).toContain("What this Mac has installed that a package manager could put on the image");
    expect(screen).toContain("nothing found here yet");
    await f.press(KEY.enter);
    await throughScreens(f, ["Sign-ins", "wsp for your agents on this Mac"]);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("once this computer has measured a build, the build screen says how long that one took", async () => {
    const f = fake();
    // What the last seal wrote beside the recipe: 19 minutes of stages.
    writeFileSync(importResultPath(f.opts.statePath), JSON.stringify({ build: { at: "2026-09-05T19:44:00.000Z", stages: { creating: 61_000, "installing-tools": 1_059_000, snapshotting: 40_000 } } }));
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    const ready = f.text().slice(f.text().lastIndexOf("Ready to build")).replace(/\n┃\s+/g, " ");
    expect(ready).toContain("The build takes about 19 minutes, going by the last one; a workspace naps when it is idle and stops billing.");
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("the build screen says what it will build, what it costs and that a workspace naps; the marker opens on Yes and n keeps everything", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    const frame = f.text().slice(f.text().lastIndexOf("Ready to build")).replace(/\n┃\s+/g, " ");
    const ready = frame.slice(0, frame.indexOf("Boot a"));
    expect(ready).toMatch(/^Ready to build\. 1 agent, 2 tools, [\d.]+ GB on the image\. 2 sign-ins on the machine after the build\. The build takes about ten minutes, not measured on this computer yet; a workspace naps when it is idle and stops billing\./);
    // The rate is the boot question's, said once on the screen.
    expect(ready).not.toContain("/hr");
    expect(frame.match(/\$0\.11\/hr/g)).toHaveLength(1);
    const ask = f.text().slice(f.text().lastIndexOf("Boot a"));
    expect(ask).toMatch(/2 vCPU, 4 GB\s+builder/);
    expect(ask).toMatch(/\$0\.11\/hr/);
    expect(ask).toMatch(/No\s+costs\s+nothing/);
    // Enter takes the defaults everywhere, so the marker opens on Yes; the help line is the screen being answered.
    expect(ask).toContain(`\n┃  ${S_RADIO_ACTIVE} Yes / ${S_RADIO_INACTIVE} No\n┗  ← → change • y n answer • enter choose • esc cancel`);
    await f.press("n");
    expect((await run).code).toBe(1);
    // The finished block opens on the summary line, the boot question under it, and ends on the answer.
    const done = f.text().slice(f.text().lastIndexOf("◇  Ready to build"));
    expect(done).toContain("│  No\n└  Nothing was booted. The recipe is kept.");
    expect(done).toMatch(/^◇  Ready to build\./);
    expect(done).toContain("Boot a");
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
    expect(f.hosts).toBe(0);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.filter(e => e.bring).map(e => e.id)).toContain("shell/zshrc");
  });

  it("a seal whose fork fails its check is reported with the run log, exits 1 with the host closed, and the builder is gone", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      // The smoke command fails on the fork alone; the builder's own stages answer as a bare guest does.
      backend.execImpl = (m, cmd) => (m.spec.fromSnapshot !== undefined ? { exitCode: 3, stdout: "", stderr: "claude: not found" } : guestAnswer(cmd));
      f.backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
      f.runtimes.push(rt);
      return rt;
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(result.handle).toBeUndefined();
    expect(f.hosts).toBe(1);
    expect(f.hostsClosed).toBe(1);
    const out = f.text();
    expect(out).toContain("Sealing golden v1. Taken as yes (--yes).");
    expect(out).toContain("The fork failed its check");
    expect(out).toContain("Seal failed and the builder is gone. Run wsp init again; the recipe is kept.");
    expect(out).toContain(`The run log is ${join(dirname(f.opts.statePath), "init.log")}`);
    expect(out).not.toMatch(URL_RE);
    expect(f.backends[0]!.machines.every(m => m.killed)).toBe(true);
  });

  it("no at the seal question leaves the builder running for a later attach, closes the host and exits 1", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until(SEAL_Q(1));
    expect(f.text()).toContain("Enter seals: a snapshot, then a fork to prove it. No leaves the machine up.");
    await f.press("n");
    const result = await run;
    expect(result.code).toBe(1);
    expect(result.handle).toBeUndefined();
    expect(f.hostsClosed).toBe(1);
    expect(f.text()).toContain(`Nothing was sealed. Builder m1 stays up at about $0.11/hr; wsp init --recipe ${join(dirname(f.opts.statePath), "recipe.json")} attaches to it again, and the sweep stops it once it is six hours old.`);
    expect(f.backends[0]!.machines.map(m => m.killed)).toEqual([false]);
    expect(await f.runtimes.at(-1)!.golden.get()).toBeUndefined();
    expect(f.opened).toEqual([]);
  });

  it("the detect spinner counts each rung as the collector finishes it, before the found note", async () => {
    const f = fake({
      collect: async onRung => {
        for (const rung of RUNGS) onRung(rung, FIXTURE.entries.filter(e => e.rung === rung).length);
        return FIXTURE;
      },
      recipe: async onHistory => {
        for (const h of RECIPE.histories) onHistory(h);
        return RECIPE;
      },
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/6");
    const t = f.text();
    expect(t).toContain("Reading this computer  Identity 3");
    expect(t).toContain("Reading this computer  Identity 3, Shell 2, Toolchains 1, Tools 4, Agents 2, Sign-ins 3");
    expect(t.indexOf("Sign-ins 3")).toBeLessThan(t.indexOf("Found on this computer"));
    // Then the recipe is read, its own spinner naming each agent's history as it lands.
    expect(t.indexOf("Reading what your agents used")).toBeGreaterThan(t.indexOf("Sign-ins 3"));
    expect(t).toContain("Reading what your agents used  Claude Code: no history here");
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("on a narrow terminal the tally is cut to the width so the spinner line never wraps onto itself", async () => {
    const f = fake({
      columns: 48,
      collect: async onRung => {
        for (const rung of RUNGS) onRung(rung, FIXTURE.entries.filter(e => e.rung === rung).length);
        return FIXTURE;
      },
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/6");
    const spins = f.text().split("\r").filter(l => l.includes("Reading this computer"));
    expect(spins.length).toBeGreaterThan(1);
    expect(spins.map(l => l.length).filter(n => n > 48)).toEqual([]);
    expect(spins.filter(l => /Identity 3$/.test(l)).length).toBeGreaterThan(0);
    expect(spins.at(-1)).toMatch(/Identity 3, Shell 2.*…$/);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("nothing found on this machine still offers the six agents, unticked, and reaches the confirm", async () => {
    // A Mac with none of the agents: the recipe found nothing installed either, so no row offers the wsp tools.
    const none = { kind: "popular", sessions: 0, images: 0 } as const;
    const f = fake({ collect: async () => ({ entries: [] }), recipe: async () => ({ ...RECIPE, rows: RECIPE.rows.map(r => ({ ...r, on: r.kind === "tool" && r.source.kind === "popular", ...(r.source.kind === "installed" ? { source: none } : {}) })) }) });
    const run = runInit(f.opts, f.io);
    await f.until("Agents");
    expect(f.text()).toContain("Nothing found to bring");
    // The catalog's six, none ticked: a fresh Mac still gets to try them on a machine.
    expect(f.text()).toContain("On: 0 agents, 0 B");
    for (const name of ["Claude Code", "Codex", "Gemini CLI", "OpenCode", "Pi", "Hermes Agent"]) expect(f.text()).toMatch(new RegExp(`○ ${name}\\s+catalog\\s+not installed here\\s+[\\d.]+ MB`));
    await f.press(KEY.enter);
    await f.until("Tools  2/6");
    // Nothing here and nothing ticked: the base rows still come, and every other row is on the screen at its size.
    // Sixteen base rows fold behind the visible two, and the why column is cut to the screen's width.
    expect(f.text()).toMatch(/• fd\s+base\s+always on th\S*\s+2\.9 MB\n/);
    expect(f.text()).toContain("On: 16 tools, 1.5 GB");
    await f.press(KEY.enter);
    await f.until("Also on this Mac");
    expect(f.text()).toContain("nothing found here yet");
    await f.press(KEY.enter);
    await f.until("Sign-ins  4/6");
    expect(f.text()).toContain("nothing found");
    await f.press(KEY.enter);
    await f.until("wsp for your agents on this Mac");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });
});

describe("wsp init, the project the run is for", () => {
  it("with no folder named the first screen asks for one, and what it answers is read, carded and grouped on the tools screen", async () => {
    const f = fake();
    delete f.opts.project;
    const asked: string[] = [];
    f.opts.scanProject = async folder => {
      asked.push(folder);
      return { dir: folder, rows: [{ id: "go", name: "Go", why: "go.mod needs Go" }, { id: "docker", name: "Docker engine and compose", why: "compose.yaml needs Docker" }], candidates: [{ id: "ruby", name: "Ruby", why: "Gemfile needs Ruby" }] };
    };
    const run = runInit(f.opts, f.io);
    await f.until(PROJECT_QUESTION);
    expect(f.text()).toContain("optional; a folder on this Mac, read for what its own files say it needs");
    await f.press(..."~/proj".split(""), KEY.enter);
    await f.until("Your project needs");
    expect(asked).toEqual(["~/proj"]);
    const card = f.text().slice(f.text().lastIndexOf("Your project needs"));
    expect(card).toContain("go.mod needs Go");
    expect(card).toContain("Not in the catalog: Ruby (Gemfile needs Ruby)");
    await f.until("Agents");
    await f.press(KEY.enter);
    await f.until("Tools  2/6");
    // Go is off in the catalog and never used here; the folder's own go.mod put it on the machine, in its own group.
    expect(f.text()).toMatch(/▾ Your project needs\s+1 of 1\s+239\.1 MB/);
    expect(f.text()).toMatch(/● +Go +project +go\.mod needs… +239\.1 MB/);
    await f.press(KEY.enter);
    await throughScreens(f, ["Also on this Mac", "Sign-ins", "wsp for your agents"]);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("an empty answer asks nothing more: the folder is optional and the ticks stand as this computer left them", async () => {
    const f = fake();
    delete f.opts.project;
    const asked: string[] = [];
    f.opts.scanProject = async folder => {
      asked.push(folder);
      return { dir: folder, rows: [], candidates: [] };
    };
    const run = runInit(f.opts, f.io);
    await f.until(PROJECT_QUESTION);
    await f.press(KEY.enter);
    await f.until("Agents");
    expect(asked).toEqual([]);
    expect(f.text()).not.toContain("Your project needs");
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("an answer that names no folder is said so, not read as a project that needs nothing", async () => {
    const f = fake();
    delete f.opts.project;
    f.opts.scanProject = async () => undefined;
    const run = runInit(f.opts, f.io);
    await f.until(PROJECT_QUESTION);
    await f.press(..."~/prj".split(""), KEY.enter);
    await f.until(noFolderNote("~/prj"));
    expect(f.text()).not.toContain("named a tool the catalog carries");
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("a folder named on the command line is not asked for again, and cards what it asked for the way the question does", async () => {
    const f = fake();
    f.opts.recipe = async (_onHistory, onProject) => {
      onProject({ dir: NAMED_PROJECT, rows: [{ id: "go", name: "Go", why: "go.mod needs Go" }], candidates: [] });
      return RECIPE;
    };
    const run = runInit(f.opts, f.io);
    await f.until("Your project needs");
    expect(f.text().slice(f.text().lastIndexOf("Your project needs"))).toContain("go.mod needs Go");
    await f.until("Agents");
    expect(f.text()).not.toContain(PROJECT_QUESTION);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });
});

describe("wsp init, the summary-first screens", () => {
  const hermesKeys: ManifestEntry = { rung: "logins", id: "logins/hermes-keys", label: "Hermes Agent API keys", group: "Agent logins", paths: ["~/.hermes/.env"], bytes: 25_000, default: "bring", detail: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" };
  const hermesLogin: ManifestEntry = { rung: "logins", id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: ["~/.hermes/auth.json"], bytes: 400, default: "skip" };
  const hermes: ManifestEntry = { rung: "agents", id: "agents/hermes", label: "Hermes Agent", paths: ["~/.hermes/config.yaml"], bytes: 600, default: "bring" };
  const kube: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "bring" };
  const github: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", consent: true, detail: "stdio: npx @modelcontextprotocol/server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)" };
  const notes: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", detail: "stdio: npx notes-mcp; runs via npx; carries no secret" };
  /** This Mac with Hermes beside Claude Code and two of Claude Code's MCP servers, one with a token; a recipe that ticks Codex too, a tool the agents used that is not here, and one they looked at once. */
  const LAPTOP: Manifest = { entries: [...FIXTURE.entries, hermes, hermesLogin, hermesKeys, kube, github, notes] };
  const MEASURED: Recipe = {
    ...RECIPE,
    rows: [
      ...RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true } : r)),
      { id: "hermes", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.hermes/config.yaml"], bin: true } },
      { id: "wrangler", kind: "tool", on: true, source: { kind: "used", sessions: 3, calls: 40 } },
      { id: "go", kind: "tool", on: false, source: { kind: "used", sessions: 1, calls: 2 } },
    ],
  };

  it("five screens: the agents with what this computer did with each, the tools table, the scan slot, a choice per sign-in and the wsp tools; then the build installs the agent ticked here and signs it in on the machine", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED, columns: 100 });
    // A tall terminal, so the whole tools list is on screen at once.
    Object.assign(f.io.output, { rows: 50 });
    for (const [rel, text] of [[".hermes/.env", "OPENAI_API_KEY=sk-x\n"], [".hermes/auth.json", "{}"], [".hermes/config.yaml", "model: x\n"], [".kube/config", "current-context: minikube\n"]] as const) {
      mkdirSync(dirname(join(f.opts.home, rel)), { recursive: true });
      writeFileSync(join(f.opts.home, rel), text);
    }
    const run = runInit(f.opts, f.io);

    await f.until("Agents");
    const one = f.text();
    // Before any question: what was found; the tool the agents used that this Mac has no row for gets a bare row, not a warning.
    expect(one).toContain("21 found on this computer. Nothing has left this computer.");
    expect(one).not.toContain("not in this build");
    // The catalog's six in its order, a size beside each, the three on this Mac ticked.
    expect(one).toMatch(/◆  Agents  1\/6\n┃ {2}Which coding agents go on your machine image\.\n┃ {2}You can change this later\.\n┃ {2}search/);
    expect(one).toContain("On: 3 agents, 1.1 GB");
    expect(one).toMatch(/● Hermes Agent\s+installed\s+installed here, never used\s+484\.0 MB\n┃\s+● Claude Code\s+installed\s+installed here, never used\s+208\.0 MB\n┃\s+● Codex\s+catalog\s+not installed here\s+455\.0 MB\n/);
    // Down onto Gemini CLI: the detail says wsp cannot drive it yet and what installs; space ticks it for the machine.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
    await f.until("about 189.0 MB installed on the machine (measured 2026-09-05)");
    expect(f.text()).toContain("installs, but wsp cannot run its threads yet");
    expect(f.text()).toContain("not on this Mac; try it on the machine, nothing here changes");
    await f.press(KEY.space);
    await f.until(/● Gemini CLI/);
    await f.press(KEY.enter);

    await f.until("Tools  2/6");
    const two = f.text().slice(f.text().lastIndexOf("◆  Tools"));
    // Screen two is the list itself: the base as bullets under the title, then a group per why, every row with its
    // count and its size, the totals and the Disk line under them. Nothing is hidden behind a key.
    expect(two).toMatch(/^◆  Tools  2\/6\n┃ {2}What installs on the image, from what you use\.\n┃ {2}You can change this later\.\n┃ {2}search/);
    expect(two).toMatch(/▾ Always on the image\s+16\s+1\.5 GB\n┃\s+• Docker engine and compose\s+base\s+always on the image\s+516\.7 MB\n/);
    expect(two).toMatch(/▾ You use these\s+1 of 2\s+239\.4 MB\n┃\s+○ Go\s+used\s+below the floor, 2 commands in 1[^\n]*?239\.1 MB\n┃\s+● Cloudflare Wrangler\s+used\s+40 commands in 3 sessions\s+239\.4 MB\n/);
    expect(two).toMatch(/▾ Installed here, never used\s+2 of 2\s+53\.8 MB\n┃\s+● GitHub CLI\s+installed\s+installed here, never used\s+40\.2 MB\n┃\s+● yq\s+installed\s+installed here, never used\s+13\.5 MB\n/);
    expect(two).toMatch(/On: 19 tools, 1\.8 GB\n┃ {2}on when used in 2 sessions and 5 commands; heavy rows 3 and 20\n┃ {2}Disk: [\d.]+ GB of 15\.2 GB on the 20 GB builder\n┗ {2}space on or off • ← → fold • enter next • esc back/);
    expect(two).not.toContain("adjust");
    expect(two).not.toContain("every row on this screen that can be ticked");
    // Typing narrows the rows to a match; space unticks yq and the totals follow it.
    await f.press("y", "q");
    await f.until(/search {2}yq/);
    await f.press(KEY.space);
    await f.until(/○ yq/);
    expect(f.text().slice(f.text().lastIndexOf("◆  Tools"))).toContain("On: 18 tools");
    await f.press(KEY.enter);

    await f.until("Also on this Mac  3/6");
    await f.press(KEY.enter);

    await f.until("Sign-ins  4/6");
    const four = f.text().slice(f.text().lastIndexOf("◆  Sign-ins"));
    // Every row carries the word it will act on, the agents first, then the CLIs, then the servers with auth.
    expect(four).toMatch(/▾ Agents\s+1 copy\s+4 sign in\s+0 API key\s+0 skip\n/);
    expect(four).toMatch(/Claude Code login\s+[^\n]*sign in on the machine\n/);
    expect(four).toMatch(/Hermes Agent API keys\s+[^\n]*copy from this Mac\n/);
    expect(four).toMatch(/▾ Developer CLIs\s+0 copy\s+1 sign in\s+1 skip\n┃\s+GitHub CLI login\s+[^\n]*sign in on the machine\n┃\s+kubectl config\s+kubectl is not coming\s+skip\n/);
    expect(four).toMatch(/▾ MCP servers from your agents' configs\s+0 copy\s+1 skip\n┃\s+github\s+in Claude Code's config\s+skip\n/);
    expect(four).not.toContain("notes");
    expect(four).not.toContain("wsp tools");
    // Right on the Hermes keys row walks it to the next word it takes.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
    await f.until("the keys in ~/.hermes/.env travel only by copy; no sign-in produces them");
    // The keys travel only by copy: no sign-in produces them, so the row walks between copy and skip alone.
    await f.press(KEY.right);
    await f.until(/Hermes Agent API keys\s+[^\n]*skip/);
    await f.press(KEY.left);
    await f.until(/Hermes Agent API keys\s+[^\n]*copy from this Mac/);
    await f.press(KEY.enter);

    await f.until("wsp for your agents on this Mac  5/6");
    await f.press(KEY.enter);

    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"), f.text().lastIndexOf("Recipe saved"));
    // The four agents and the one MCP server without a secret; the one with a token, unticked, is out and unlisted.
    // Gemini's row is the catalog's, added after what the collector found, so it installs last.
    expect(summary).toMatch(/Agents\s+5 of 8/);
    expect(summary).toMatch(/Sign-ins\s+1 copy, 5 sign in\s+24\.4 KB\n/);
    expect(summary).toMatch(/Hermes Agent API keys\s+copy\n/);
    expect(summary).toMatch(/kubectl config\s+skip\n/);
    expect(summary).not.toContain("github");
    expect(summary.replace(/\n\s*│?\s+/g, " ")).toMatch(/Installs\s+Claude Code, Codex, Hermes Agent, Gemini CLI, 2 tools plus Homebrew's toolchain, 1 MCP server/);
    expect(f.text()).toMatch(/Recipe saved to .*golden-recipe\.json and .*recipe\.json/);
    await f.press("y");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).not.toMatch(/—|\p{Emoji_Presentation}/u);
    // The four agents installed, Gemini from the catalog's road though nothing of it is on this Mac; the five sign-ins ran here.
    expect(out).toMatch(/Agents\n│\s+4 installed: Claude Code, Codex, Hermes Agent, Gemini CLI\n/);
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["exec gh auth login || exit\r", "exec claude auth login || exit\r", "exec codex login || exit\r", "exec hermes auth || exit\r", "exec gemini || exit\r"]);
    expect(out).toMatch(/Gemini CLI login: signed in \(gemini exited 0\)/);
    expect(f.reads).toEqual([]);
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log.some(c => c.includes("@google/gemini-cli@"))).toBe(true);
    expect(log.some(c => c.includes("brew install yq"))).toBe(false);
    expect(log.some(c => c.includes("brew install gh"))).toBe(true);
    // Both recipe files: the collector's rows with the ticks, and the small one with the catalog ids, ticks and answers as the screens left them.
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/gemini")).toMatchObject({ bring: true, paths: [] });
    expect(saved.get("agents/pi")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/yq")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/gh")).toMatchObject({ bring: true });
    expect(saved.get("tools/npm/tsx")).toMatchObject({ bring: false });
    // The keys row was left on copy, so it travels; the login beside it still signs in on the machine.
    expect(saved.get("logins/hermes-keys")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("logins/hermes")).toMatchObject({ bring: false, choice: "machine" });
    expect(saved.get("logins/gemini")).toMatchObject({ bring: false, choice: "machine" });
    expect(saved.get("logins/kube")).toMatchObject({ bring: false, choice: "skip" });
    expect(saved.get("agents/mcp/claude/github")).toMatchObject({ bring: false, choice: "skip" });
    expect(saved.get("agents/mcp/claude/notes")).toMatchObject({ bring: true });
    // The server with the token was never ticked, so the build left it off the machine's config and says why.
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).mcp).toEqual(expect.arrayContaining([expect.objectContaining({ name: "github", outcome: "skipped", note: "unticked" })]));
    const small = Recipe.parse(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")));
    const rows = new Map(small.rows.map(r => [r.id, r]));
    expect(rows.get("gemini")).toMatchObject({ on: true, signIn: "machine" });
    expect(rows.get("codex")).toMatchObject({ on: true, signIn: "machine" });
    expect(rows.get("claude")).toMatchObject({ on: true, signIn: "machine" });
    expect(rows.get("hermes")).toMatchObject({ on: true, signIn: "machine" });
    expect(rows.get("yq")).toMatchObject({ on: false });
    expect(rows.get("gh")).toMatchObject({ on: true, signIn: "machine" });
    expect(rows.get("wrangler")).toMatchObject({ on: true });
    expect(rows.get("node")).toMatchObject({ on: true });
    expect(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")).not.toMatch(/sk-x|minikube/);
  });

  it("esc steps back a screen and the ticks stand; the first screen stays put", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    const run = runInit(f.opts, f.io);
    await f.until("Agents");
    await f.press(KEY.esc);
    await new Promise(r => setTimeout(r, 100));
    expect(f.text()).not.toContain("Tools  2/6");
    // Down onto Gemini CLI and space: the tick stands when the screen is left and come back to.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.space, KEY.enter);
    await f.until("Tools  2/6");
    await f.press(KEY.esc);
    await f.until(/Agents  1\/6[\s\S]*Agents  1\/6/);
    expect(f.text().slice(f.text().lastIndexOf("◆  Agents"))).toMatch(/● Gemini CLI/);
    await f.press(KEY.enter);
    await f.until(/Tools  2\/6[\s\S]*Tools  2\/6/);
    await f.press(KEY.enter);
    await f.until("Also on this Mac");
    await f.press(KEY.esc);
    await f.until(/Tools  2\/6[\s\S]*Tools  2\/6[\s\S]*Tools  2\/6/);
    await f.press(KEY.enter);
    await f.press(KEY.enter);
    await f.until("Sign-ins  4/6");
    await f.press(KEY.esc);
    await f.until(/Also on this Mac  3\/6[\s\S]*Also on this Mac  3\/6/);
    await f.press(KEY.enter);
    await f.press(KEY.enter);
    await f.until("wsp for your agents on this Mac  5/6");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/gemini")).toMatchObject({ bring: true });
    expect(saved.get("tools/catalog/wrangler")).toMatchObject({ label: "Cloudflare Wrangler", bring: true });
  });

  it("the fifth screen offers the wsp tools to each agent on this Mac whose config the catalog knows; ticked, the server is in that config here when the screens end", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    const run = runInit(f.opts, f.io);
    await throughScreens(f, ["Agents", "Tools", "Also on this Mac", "Sign-ins"]);
    await f.until("wsp for your agents on this Mac  5/6");
    const five = f.text().slice(f.text().lastIndexOf("◆  wsp for your agents on this Mac"));
    // Claude Code is the one agent here whose config the catalog can place a server in: Hermes is here without one, Codex is not here.
    expect(five).toContain("Add wsp's MCP server and skill to the agents installed here, so they can");
    expect(five).toMatch(/○ Claude Code\n/);
    expect(five).not.toMatch(/(Codex|Hermes Agent|Pi|Gemini CLI|OpenCode)\n/);
    // This computer has run no session with it, so the row starts off; the file it would write reads under it.
    expect(five).toContain("writes ~/.claude.json");
    await f.press(KEY.space);
    await f.until(/● Claude Code/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    // The helper's own line, after the recipe is saved and before anything boots.
    const out = f.text();
    expect(out).toContain("Claude Code now has the wsp tools: ~/.claude.json");
    expect(out.indexOf("Recipe saved to")).toBeLessThan(out.indexOf("Claude Code now has the wsp tools"));
    const written = JSON.parse(readFileSync(join(f.opts.home, ".claude.json"), "utf8")) as { mcpServers: { wsp: { command: string; args: string[] } } };
    expect(written.mcpServers.wsp.command).toBe(process.execPath);
    expect(written.mcpServers.wsp.args.slice(-3)).toEqual(["mcp", "--state", f.opts.statePath]);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("unticked, the offer writes nothing on this Mac; a config that is not its format is refused in one line, left as it was, and the run goes on", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    expect(f.text()).not.toContain("now has the wsp tools");
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    await f.press("n");
    expect((await run).code).toBe(1);

    const broken = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    writeFileSync(join(broken.opts.home, ".claude.json"), "[]\n");
    const second = runInit(broken.opts, broken.io);
    await throughScreens(broken, ["Agents", "Tools", "Also on this Mac", "Sign-ins"]);
    await broken.until("wsp for your agents on this Mac  5/6");
    await broken.press(KEY.space);
    await broken.until(/● Claude Code/);
    await broken.press(KEY.enter);
    await broken.until(BOOT);
    expect(broken.text()).toMatch(/Claude Code did not get the wsp tools: ~\/\.claude\.json: [^\n]+\. Fix the file and run wsp mcp install --agent claude\./);
    expect(readFileSync(join(broken.opts.home, ".claude.json"), "utf8")).toBe("[]\n");
    await broken.press("n");
    expect((await second).code).toBe(1);
  });

  it("--yes never writes an agent's config on this computer, however this Mac's own sessions would have ticked it, and says how to do it by hand", async () => {
    // Claude Code has run here, so screen five would have opened with its row on; nobody answered it.
    const used: Recipe = { ...MEASURED, histories: [{ agent: "claude", state: "read", sessions: 151, calls: 4102 }] };
    const f = fake({ yes: true, collect: async () => LAPTOP, recipe: async () => used });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    expect(f.text()).toContain("The wsp tools were not added to Claude Code here: a run taken as yes (--yes) writes nothing on this computer. Run wsp mcp install --agent claude to add them.");
  });

  it("under --yes the recipe decides the ticks, the keys copy, the logins wait for the machine, and both recipe files are written; no agent's config here is touched", async () => {
    const f = fake({ yes: true, collect: async () => LAPTOP, recipe: async () => MEASURED });
    for (const rel of [".hermes/.env", ".hermes/auth.json", ".hermes/config.yaml", ".kube/config"]) {
      mkdirSync(dirname(join(f.opts.home, rel)), { recursive: true });
      writeFileSync(join(f.opts.home, rel), "x\n");
    }
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).not.toMatch(/Agents  1\/6|Tools  2\/6|Sign-ins  4\/6/);
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    expect(out).not.toContain("not in this build");
    expect(out.replace(/\n\s*│?\s+/g, " ")).toMatch(/Installs\s+Claude Code, Codex, Hermes Agent, 3 tools plus Homebrew's toolchain, 1 MCP server/);
    expect(out).toMatch(/Hermes Agent API keys\s+copy\n/);
    // The server with a token is consent: nobody is here to give it, so it stays off the machine.
    expect(out).not.toMatch(/github\s+copy/);
    // The copied keys are on the machine; their status is the catalog's to check from the app, not this terminal's.
    expect(out).toContain("Hermes Agent API keys: copied");
    expect(out).toContain("Sign-ins on the machine skipped: GitHub CLI login, Claude Code login, Codex login, Hermes Agent login. --yes asks nothing; sign in from the app's terminal.");
    expect(f.reads).toEqual([]);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/codex")).toMatchObject({ bring: true });
    expect(saved.get("agents/gemini")).toMatchObject({ bring: false });
    expect(saved.get("tools/npm/tsx")).toMatchObject({ bring: false });
    expect(saved.get("tools/catalog/wrangler")).toMatchObject({ label: "Cloudflare Wrangler", bring: true });
    expect(saved.get("logins/hermes-keys")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("logins/kube")).toMatchObject({ bring: false, choice: "skip" });
    expect(saved.get("agents/mcp/claude/github")).toMatchObject({ bring: false, choice: "skip" });
    expect(saved.get("agents/mcp/claude/notes")).toMatchObject({ bring: true });
    const small = Recipe.parse(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")));
    expect(small.rows.filter(r => r.on).map(r => r.id)).toEqual(["claude", "codex", "node", "pnpm", "uv", "python", "git", "jq", "ripgrep", "curl", "docker", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync", "gh", "yq", "hermes", "wrangler"]);
    expect(small.rows.find(r => r.id === "gh")).toMatchObject({ signIn: "machine" });
    expect(small.rows.find(r => r.id === "go")).not.toHaveProperty("signIn");
    // --yes answers every row with the word its screen would have opened on: the same map signInItems hands the screen.
    const screens = signInItems(applyRecipe(withCatalogAgents(LAPTOP), MEASURED));
    for (const [id, choice] of screens.initial) {
      // The one exception is a Keychain login, which nobody is here to consent to; the run says so on the screen above.
      if (choice === "copy" && saved.get(id)?.paths.some(p => p.startsWith("Keychain:")) === true) continue;
      expect([id, saved.get(id)?.choice]).toEqual([id, choice]);
    }
  });
});

describe("wsp init, the secrets step", () => {
  it("a cut secret is skipped under --non-interactive naming that flag, and under --yes off a terminal naming the terminal, as the sign-ins do", async () => {
    const tty = fake({ nonInteractive: true });
    writeFileSync(join(tty.opts.home, ".zshrc"), "export A_KEY=fake\n");
    expect((await runInit(tty.opts, tty.io)).code).toBe(0);
    expect(tty.text()).toContain("Secrets skipped: A_KEY (cut from ~/.zshrc). --non-interactive asks nothing; set them from the app's terminal.");

    const pipe = fake({ yes: true, tty: false });
    writeFileSync(join(pipe.opts.home, ".zshrc"), "export A_KEY=fake\n");
    expect((await runInit(pipe.opts, pipe.io)).code).toBe(0);
    expect(pipe.text()).toContain("Secrets skipped: A_KEY (cut from ~/.zshrc). No terminal to paste into; set them from the app's terminal.");
    expect(pipe.text()).toContain("Sign-ins on the machine skipped: GitHub CLI login, Claude Code login. No terminal to sign in from; use the app's terminal.");
  });

  it("an rc file with a cut secret export is named in the secrets step, skipped under --yes with the reason and recorded", async () => {
    // The recipe row carries no secrets field: the names come from the pack, which strips the file as it stands at build time.
    const f = fake({ yes: true });
    writeFileSync(join(f.opts.home, ".zshrc"), "export A=1\nexport A_KEY=fake\n");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Secrets skipped: A_KEY (cut from ~/.zshrc). --yes asks nothing; set them from the app's terminal.");
    expect(out).toMatch(/Secrets\n│\s+A_KEY\s+skipped \(--yes asks nothing; set them from the app's terminal\)\n/);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      secrets: [{ name: "A_KEY", from: "cut from ~/.zshrc", state: "skipped", note: "--yes asks nothing; set them from the app's terminal" }],
    });
    // The value never went anywhere: no pty was opened for it.
    expect(f.link.ptys.filter(p => p.created["env"] !== undefined && "WSP_SECRET_LINE" in (p.created["env"] as object))).toEqual([]);
  });

  it("on a terminal each cut secret is asked for hidden and set before any sign-in runs; the pasted value rides the pty's environment into the machine's secrets file, out of the screen and the run log", async () => {
    const f = fake();
    writeFileSync(join(f.opts.home, ".zshrc"), "export A=1\nexport ANTHROPIC_API_KEY=fake\n");
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Paste each value to set it on the machine, or leave it empty to skip.");
    expect(f.text()).not.toContain("Signing in on the machine");
    await f.until("cut from ~/.zshrc; the value is set on the machine and never shown here");
    await f.press(..."s3cret-value".split(""), KEY.enter);
    await f.until("ANTHROPIC_API_KEY: set in /etc/profile.d/wsp-secrets.sh on the machine");
    await f.until("Claude Code login: signed in (claude auth login exited 0)");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.secrets).toEqual([{ name: "ANTHROPIC_API_KEY", from: "cut from ~/.zshrc", state: "set" }]);
    const out = f.text();
    expect(out.indexOf("Paste each value")).toBeGreaterThan(out.indexOf("Ready"));
    expect(out.indexOf("Paste each value")).toBeLessThan(out.indexOf("Signing in on the machine"));
    expect(out.indexOf("Signing in on the machine")).toBeLessThan(out.indexOf("Ready to seal golden v1"));
    expect(out).toMatch(/Secrets\n│\s+ANTHROPIC_API_KEY\s+set on the machine\n/);
    expect(out).not.toContain("s3cret");
    // The machine's secrets file is read first (nothing there on a fresh builder, no fish), then the one write, and
    // only then the sign-ins.
    const read = f.link.ptys.find(p => p.writes[0]!.startsWith(readCommand()))!;
    expect(read.created["env"]).toEqual({ PS1: "" });
    const pty = f.link.ptys.find(p => p.created["env"] !== undefined && "WSP_SECRET_LINE" in (p.created["env"] as object))!;
    expect(pty.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", WSP_SECRET_LINE: "export ANTHROPIC_API_KEY='s3cret-value'" } });
    expect(pty.writes).toEqual([`${appendCommand(false)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(pty.killed).toBe(true);
    const lines = f.link.ptys.map(p => p.writes[0]!);
    expect(lines.indexOf(pty.writes[0]!)).toBeLessThan(lines.findIndex(l => l.startsWith("exec ")));
    // The read, the write, gh's sign-in, claude's sign-in.
    expect(f.link.dials).toBe(4);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      logins: [{ id: "logins/gh", state: "signed-in" }, { id: "logins/claude", state: "signed-in", note: "claude auth login exited 0" }],
      secrets: [{ name: "ANTHROPIC_API_KEY", from: "cut from ~/.zshrc", state: "set" }],
    });
    expect(readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8")).not.toContain("s3cret");
  });

});

describe("wsp init, the sign-in stage", () => {
  /** Codex alone is on, so its login is the one listed; the kubeconfig's command is not coming, so that row is locked at skip. */
  const CODEX = without(ticking("codex"), "claude");
  const CODEX_MANIFEST: Manifest = {
    entries: [
      FIXTURE.entries[0]!,
      { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: ["~/.codex/auth.json"], bytes: 300, default: "skip" },
      { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "skip" },
    ],
  };

  it("a login the status check does not confirm is offered a retry, then the table's fallback, then a skip; o opens the page here and arms auto-open for that command only; the skip lands in the notes", async () => {
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    expect(f.text()).toMatch(/Codex login\s+[^\n]*sign in on the machine/);
    await f.until(BOOT);
    await f.press("y");

    // The default flow first: the shim would open the page; here the printed URL is offered with o.
    await f.until(/Codex login\s+codex login\n/);
    await f.until("Press Enter to open https://github.com/login/device");
    const builderId = f.backends[0]!.machines[0]!.id;
    expect(f.hooks[0]!.autoOpen(builderId, DEVICE_URL)).toBe(false);
    // While the pty is on screen the shim's line says what to press here; outside it the relay keeps its own words.
    expect(f.hooks[0]!.openLine("default (builder)", "github.com", DEVICE_URL)).toBe("default (builder): press o on the link above to open it here");
    expect(f.hooks[0]!.openLine("task-1", "github.com", DEVICE_URL)).toBe("task-1: a sign-in page for github.com is ready; open it from the app");
    await f.press("o");
    await f.until("opened on this computer");
    expect(f.opened).toEqual([DEVICE_URL]);
    // gh's Enter re-sends the page o just opened: the pty says so instead of asking for o again.
    expect(f.hooks[0]!.openLine("default (builder)", "github.com", DEVICE_URL)).toBe("default (builder): that page is already open here");
    expect(f.hooks[0]!.openLine("default (builder)", "other.test", "https://other.test/a")).toBe("default (builder): press o on the link above to open it here");
    // One o arms exactly one auto-open, and never for the page o already opened here (gh's Enter re-sends that one).
    expect(f.hooks[0]!.autoOpen("some-other-workspace", "https://other.test/a")).toBe(false);
    expect(f.hooks[0]!.autoOpen(builderId, DEVICE_URL)).toBe(false);
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/a")).toBe(true);
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/a")).toBe(false);
    await f.press("o");
    await f.until(/opened on this computer[\s\S]*opened on this computer/);
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/b")).toBe(true);
    // A host line during the pty lands inside it, dim, instead of breaking the raw terminal.
    expect(f.hooks[0]!.onLine("default (builder): forwarding localhost:1455 on this computer")).toBe(true);
    expect(f.text()).toContain("default (builder): forwarding localhost:1455 on this computer");
    await f.press("\x03");
    await f.until("Codex login: not signed in (codex login exited 130)");
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/c")).toBe(false);
    expect(f.hooks[0]!.onLine("later")).toBe(false);
    expect(f.hooks[0]!.openLine("default (builder)", "github.com", DEVICE_URL)).toBe("default (builder): a sign-in page for github.com is ready; open it from the app");

    await f.until("r retry   f retry with codex login --device-auth   s skip");
    await f.press("r");
    await f.until(/codex login\n[\s\S]*Press Enter to open[\s\S]*Press Enter to open/);
    await f.press("\x03");
    await f.until(/not signed in[\s\S]*not signed in[\s\S]*r retry/);
    await f.press("f");
    await f.until(/Codex login\s+codex login --device-auth/);
    await f.press("\x03");
    await f.until(/not signed in[\s\S]*not signed in[\s\S]*not signed in[\s\S]*r retry/);
    await f.press("s");

    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Codex login\s+skipped\s+skipped by you/);
    // Three login ptys (default, retry, fallback), no status run after any of them and no check script since nothing was copied; o never reached the machine.
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["exec codex login || exit\r", "exec codex login || exit\r", "exec codex login --device-auth || exit\r"]);
    expect(f.link.ptys.flatMap(p => p.writes.slice(1))).toEqual(["\x03", "\x03", "\x03"]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [{ id: "logins/codex", label: "Codex login", state: "skipped", command: "codex login --device-auth", note: "skipped by you" }],
    });
    expect(result.logins?.map(l => l.state)).toEqual(["skipped"]);
    expect(out).not.toMatch(/—/);
    // o opened the page twice; the device URL, the second o, then the app after the seal.
    expect(f.opened).toEqual([DEVICE_URL, DEVICE_URL, expect.stringMatching(URL_RE)]);
    // The seal stamps their states on the version.
    expect((await f.runtimes.at(-1)!.golden.get())?.versions[0]?.logins).toEqual([{ name: "Codex login", state: "skipped" }]);
  });

  it("a tool that is not on the machine (exit 127) is skipped with that reason, its status command never runs, and nothing is asked", async () => {
    const f = fake({ missing: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Codex login: skipped (codex is not on the machine)");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["exec codex login || exit\r"]);
    expect(f.text()).not.toContain("r retry");
    expect(result.logins?.[0]).toEqual({ id: "logins/codex", label: "Codex login", state: "skipped", command: "codex login", exit: 127, note: "codex is not on the machine" });
  });

  it("a machine sign-in that ended with a non-zero exit is not signed in and offered a retry or a skip; a clean exit signs it in", async () => {
    // A login whose command is not coming starts at skip and is never staged, so the tools row that brings cloudflared is here.
    const CLOUDFLARED_MANIFEST: Manifest = {
      entries: [
        FIXTURE.entries[0]!,
        { rung: "tools", id: "tools/brew/cloudflared", label: "cloudflared", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
        { rung: "logins", id: "logins/cloudflared", label: "cloudflared login", group: "CLI logins", paths: ["~/.cloudflared/cert.pem"], bytes: 300, default: "skip" },
      ],
    };
    const f = fake({ signedIn: false, hold: true, collect: async () => CLOUDFLARED_MANIFEST, recipe: async () => without(ticking("cloudflared"), "claude") });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until(/cloudflared login\s+cloudflared tunnel login\n/);
    await f.until("Press Enter to open");
    await f.press("\x03");
    await f.until("cloudflared login: not signed in (cloudflared tunnel login exited 130)");
    await f.until("cloudflared login  r retry   s skip");
    await f.press("r");
    await f.until(/Press Enter to open[\s\S]*Press Enter to open/);
    // A clean exit is the sign-in landing: nothing to check and nothing to retry.
    f.link.exit(f.link.ptys.at(-1)!, 0);
    await f.until(/signed in \(cloudflared tunnel login exited 0\)\n/);
    await f.until(SEAL_Q(1));
    await f.press(KEY.enter);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.logins?.map(l => [l.state, l.exit])).toEqual([["signed-in", 0]]);
    expect(f.text()).toMatch(/Sign-ins\n│\s+cloudflared login\s+signed in\n/);
  });

  it("an unreadable golden-import.json is said so when the logins and secrets are written into a fresh one", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-notes-"));
    dirs.push(dir);
    const path = join(dir, "golden-import.json");
    writeFileSync(path, "{ not json");
    expect(noteOutcomes(path, { logins: [{ id: "logins/gh", label: "GitHub CLI login", state: "skipped" }], secrets: [] })).toEqual({ replaced: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ logins: [{ id: "logins/gh", label: "GitHub CLI login", state: "skipped" }], secrets: [] });
    expect(noteOutcomes(path, { logins: [] })).toEqual({ replaced: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ logins: [], secrets: [] });
  });

  it("a daemon link that drops under a login ends that command as not signed in, and the retry dials a fresh link", async () => {
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Press Enter to open https://github.com/login/device");
    expect(f.link.dials).toBe(1);
    f.link.drop();
    await f.until("Codex login: not signed in (the machine's terminal link dropped)");
    await f.until("r retry   f retry with codex login --device-auth   s skip");
    await f.press("r");
    await f.until(/Press Enter to open[\s\S]*Press Enter to open/);
    expect(f.link.dials).toBe(2);
    await f.press("\x03");
    await f.until(/not signed in \(codex login exited 130\)/);
    await f.until(/exited 130[\s\S]*r retry   f retry/);
    await f.press("s");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.logins?.map(l => [l.state, l.note])).toEqual([["skipped", "skipped by you"]]);
  });

  it("outside a pty the openLine hook says exactly what the relay says by itself, hostname and all", async () => {
    // The relay's default line, read off a real relay over a fake link and a workspace named task-1.
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("/root/.wsp-daemon-token") ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const create = backend.create.bind(backend);
    backend.create = async spec => Object.assign(await create(spec), { previewUrl: async () => ({ url: "http://guest.test", token: "pt", expiresAt: Date.now() + 3_600_000 }) });
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] });
    // Nothing answers on guest.test, so the create's daemon ping is kept short.
    const rt = createRuntime({ backend, store, adapters: {}, wake: { pingTimeoutMs: 100 } });
    await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const lines: string[] = [];
    let emit: ((e: Record<string, unknown>) => void) | undefined;
    const connect = async (c: ConnectOptions): Promise<DaemonSocket> => {
      emit = c.onEvent ?? (() => {});
      let settle: (code: number) => void = () => {};
      const closed = new Promise<number>(r => (settle = r));
      return { op: async op => (op === "ports.watch" ? { ok: true, ports: [] } : { ok: true }), close: () => settle(1000), closed, beats: 0, open: true };
    };
    const relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: l => lines.push(l), connect });
    for (let i = 0; i < 200 && emit === undefined; i++) await new Promise(r => setTimeout(r, 5));
    emit!({ type: "browser.open", url: "https://github.com/login/device" });
    for (let i = 0; i < 200 && lines.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    await relay.close();
    expect(lines).toHaveLength(1);

    // init's hook, for a target that is not the builder, produces the same line.
    const f = fake({ yes: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    await runInit(f.opts, f.io);
    expect(f.hooks[0]!.openLine("task-1", "github.com", "https://github.com/login/device")).toBe(lines[0]);
  });

  it("when the machine's terminal cannot be reached the login is not signed in with the reason, can be skipped, and the seal still comes", async () => {
    const f = fake({ collect: async () => CODEX_MANIFEST, recipe: async () => CODEX, daemon: async () => { throw new Error("no daemon token"); } });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Codex login: not signed in (no daemon token)");
    await f.until("r retry   f retry with codex login --device-auth   s skip");
    await f.press("s");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.logins).toEqual([{ id: "logins/codex", label: "Codex login", state: "skipped", command: "codex login", note: "skipped by you" }]);
    // The typed key never echoes into the next line.
    expect(f.text()).not.toMatch(/\ns[│◇]/);
  });
});

describe("wsp init, logins copied to the machine", () => {
  it("a Claude login with an apiKeyHelper runs the helper once, before the boot and with the Keychain reads; a helper that fails there flips the row to a sign-in on the machine with the reason", async () => {
    const withHelper: Manifest = {
      entries: [
        FIXTURE.entries[0]!,
        { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude/settings.json"], bytes: 60, default: "bring" },
        { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: ["Helper: ~/.claude/settings.json"], bytes: 0, default: "bring", detail: "Claude Code uses the apiKeyHelper in ~/.claude/settings.json" },
      ],
    };
    const helper = "security find-generic-password -s anthropic-api-key -w";
    const settings = (f: Fake, line = helper): void => {
      mkdirSync(join(f.opts.home, ".claude"), { recursive: true });
      writeFileSync(join(f.opts.home, ".claude", "settings.json"), `{"apiKeyHelper": "${line}"}`);
    };
    const saved = (f: Fake): void => {
      f.opts.collect = async () => withHelper;
      f.opts.recipe = async () => answeredCopy("claude");
    };
    const f = fake({ tty: false });
    settings(f);
    saved(f);
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual([helper]);
    const out = f.text();
    const said = out.indexOf("Running the ~/.claude/settings.json helper, as the saved recipe answered copy; macOS may ask you to allow it.");
    expect(said).toBeGreaterThan(-1);
    expect(said).toBeLessThan(out.search(BOOT));
    expect(out).toContain("Claude Code login: copied");
    // The key travelled as the pack's secret and the copied settings.json reads it on the machine.
    const landed = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { files: { skipped: unknown[] } };
    expect(landed.files.skipped).toEqual([]);
    expect(readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8")).not.toContain("sk-ant-x-helper");

    // A settings.json the pack leaves out (here a link into a dotfiles checkout outside home) still gets its key read on
    // the machine: the pack writes a settings.json naming only the key file, and the row says so.
    const bare = fake({ tty: false });
    settings(bare);
    const outside = mkdtempSync(join(tmpdir(), "wsp-init-dotfiles-"));
    dirs.push(outside);
    renameSync(join(bare.opts.home, ".claude", "settings.json"), join(outside, "settings.json"));
    symlinkSync(join(outside, "settings.json"), join(bare.opts.home, ".claude", "settings.json"));
    saved(bare);
    const bareResult = await runInit(bare.opts, bare.io);
    expect(bareResult.code).toBe(0);
    expect(bare.reads).toEqual([helper]);
    const bareNote = "the machine's settings.json names only the key file; your Claude Code config stayed here";
    expect(bare.text()).toContain(`Claude Code login: copied (${bareNote})`);
    expect(bareResult.logins?.[0]).toEqual({ id: "logins/claude", label: "Claude Code login", state: "copied", left: bareNote });
    const landedBare = JSON.parse(readFileSync(join(dirname(bare.opts.statePath), "golden-import.json"), "utf8")) as { files: { skipped: unknown[] } };
    expect(landedBare.files.skipped).toEqual([
      { id: "agents/claude", path: "~/.claude/settings.json", note: `a link to ${realpathSync(outside)}/settings.json, outside your home directory` },
      { id: "logins/claude", path: "Helper: ~/.claude/settings.json", note: bareNote },
    ]);

    // A helper written with its key inline fails without stderr: the command line is what the shell's error carries, and it never reaches the terminal or the log.
    const inline = "printf sk-ant-x-inline; exit 1";
    const refused = fake({ yes: true });
    settings(refused, inline);
    saved(refused);
    refused.opts.secrets = {
      read: async () => {
        throw new Error("no Keychain item in this fixture");
      },
      run: async command => {
        refused.reads.push(command);
        throw Object.assign(new Error(`Command failed: /bin/sh -c ${command}\n`), { code: 1 });
      },
    };
    expect((await runInit(refused.opts, refused.io)).code).toBe(0);
    expect(refused.reads).toEqual([inline]);
    // On a terminal the spinner names what runs: the helper alone here, no Keychain item being read.
    expect(refused.text()).toContain("Running the ~/.claude/settings.json helper");
    expect(refused.text()).not.toContain("Reading your Keychain");
    expect(refused.text()).toContain("Claude Code login: the ~/.claude/settings.json helper failed (exit status 1); changed to sign in on the machine.");
    expect(refused.text()).not.toContain("sk-ant-x-inline");
    expect(readFileSync(join(dirname(refused.opts.statePath), "init.log"), "utf8")).not.toContain("sk-ant-x-inline");
    expect(loadManifest(join(dirname(refused.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/claude")?.choice).toBe("machine");
    // The copied settings.json lost its helper line, since the command runs on this computer only.
    const landedRefused = JSON.parse(readFileSync(join(dirname(refused.opts.statePath), "golden-import.json"), "utf8")) as { files: { skipped: unknown[] } };
    expect(landedRefused.files.skipped).toEqual([{ id: "agents/claude", path: "~/.claude/settings.json", note: "apiKeyHelper left out of the copy: the command runs on this computer only" }]);
  });

  it("a gh login none of whose accounts has a Keychain item is refused with every account named and signs in on the machine", async () => {
    const f = fake({ yes: true });
    withGhCopy(f);
    f.opts.secrets = {
      read: async (service, account) => {
        f.reads.push(`${service} (${account})`);
        throw new Error(`Command failed: security find-generic-password -s ${service} -a ${account} -w\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n`);
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        other:\n        Zingzy:\n    user: Zingzy\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com (other)", "gh:github.com (Zingzy)"]);
    expect(f.text()).toContain(
      "GitHub CLI login: Keychain read failed (other: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.; Zingzy: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.); changed to sign in on the machine.",
    );
    expect(f.text()).not.toContain("left behind");
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("machine");
    expect(f.recipes).toHaveLength(2);
  });
});

describe("wsp init, flags and no terminal", () => {
  it("without a terminal it behaves as --yes: defaults taken, nothing asked, the golden sealed, the first workspace forked, the address printed", async () => {
    const f = fake({ tty: false });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).toContain("Taken as yes (no terminal)");
    expect(out).toContain("Sealing golden v1. Taken as yes (no terminal).");
    expect(out).toContain("Golden v1 sealed.");
    expect(out).toMatch(/Workspace first \(ws_[0-9a-f]+\) forked from golden v1\./);
    // Off a terminal the last question is taken as yes with no folder, and the address opens on the workspace it forked.
    expect(out).toMatch(/^◇\s+Open http:\/\/127\.0\.0\.1:4400\/#w\/ws_[0-9a-f]+$/m);
    expect(out).not.toContain("Opened http");
    // The builder, its smoke fork, the first workspace.
    expect(f.backends[0]!.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_golden-v1", true], ["snap_golden-v1", false]]);
    expect((await f.runtimes.at(-1)!.workspaces.list()).map(w => w.name)).toEqual(["first"]);
    expect(f.opened).toEqual([]);
    // The gh login has a device flow, so it starts as a sign-in on the machine: nobody is here to click macOS's
    // consent dialog, so the Keychain is never asked, and the sign-in runs on the machine with its page handed over.
    expect(f.reads).toEqual([]);
    expect(out).toMatch(/GitHub CLI login\s+sign in/);
    expect(out).toContain(`GitHub CLI login: open ${DEVICE_URL} on this computer`);
    expect(out).toContain(`open '${DEVICE_URL}'`);
    expect(result.logins?.find(l => l.id === "logins/gh")).toMatchObject({ state: "signed-in", note: "gh auth login exited 0" });
    expect(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("machine");
    expect(out).not.toContain("from your Keychain");
    // Nothing is printed as an object without --json.
    expect(f.records).toEqual([]);
  });

  it("off a terminal a saved copy answer still reads the Keychain, and says what is read before macOS can ask", async () => {
    const f = fake({ tty: false });
    withGhCopy(f);
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    const out = f.text();
    const said = out.indexOf("Reading gh:github.com from your Keychain, as the saved recipe answered copy; macOS may ask you to allow it.");
    expect(said).toBeGreaterThan(-1);
    expect(said).toBeLessThan(out.search(BOOT));
    // The copied gh login is recorded as copied with nobody here and nothing runs for it; the one sign-in chosen
    // for the machine is run there and its page handed over.
    expect(f.text()).toContain("GitHub CLI login: copied");
    expect(f.text()).toContain(`Claude Code login: open ${CLAUDE_URL} on this computer`);
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["exec claude auth login || exit\r"]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [
        { id: "logins/gh", state: "copied" },
        { id: "logins/claude", state: "signed-in", note: "claude auth login exited 0" },
      ],
    });
  });

  it("under --non-interactive --json on a terminal: no screens, each sign-in's page and outcome as one object, and the run ends 0", async () => {
    const f = fake({ nonInteractive: true, json: true });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).not.toMatch(/Agents  1\/6|Sign-ins  4\/6/);
    expect(out).toContain("Taken as yes (--non-interactive)");
    expect(out).toContain("Sealing golden v1. Taken as yes (--non-interactive).");
    expect(f.records).toEqual([
      { event: "sign-in", tool: "gh", label: "GitHub CLI login", browserUrl: DEVICE_URL, nextCommand: `open '${DEVICE_URL}'`, waitSeconds: 960 },
      { event: "sign-in-result", tool: "gh", label: "GitHub CLI login", state: "signed-in", note: "gh auth login exited 0" },
      { event: "sign-in", tool: "claude", label: "Claude Code login", browserUrl: CLAUDE_URL, nextCommand: `open '${CLAUDE_URL}'`, waitSeconds: 900 },
      { event: "sign-in-result", tool: "claude", label: "Claude Code login", state: "signed-in", note: "claude auth login exited 0" },
    ]);
    expect(result.logins?.map(l => l.state)).toEqual(["signed-in", "signed-in"]);
  });

  it("under --non-interactive a recipe answering copy for a Keychain login asks nothing and still copies it", async () => {
    const f = fake({ nonInteractive: true });
    withGhCopy(f);
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    expect(f.text()).toContain("GitHub CLI login: copied");
    // The screens never ran, so nothing was typed at: the only pty is the one sign-in chosen for the machine.
    expect(f.text()).not.toMatch(/Agents  1\/6|Sign-ins  4\/6/);
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["exec claude auth login || exit\r"]);
  });

  it("on a terminal without the flag the six screens still run", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    for (const screen of SCREENS) expect(f.text()).toContain(screen);
    await f.press("n");
    expect((await run).code).toBe(1);
    expect(f.records).toEqual([]);
  });

  it("a Keychain login the reader refuses is read before anything boots, turns into a sign-in on the machine, and says so before the confirm", async () => {
    const f = fake({ yes: true });
    withGhCopy(f);
    f.opts.secrets = {
      read: async service => {
        f.reads.push(service);
        throw new Error(`Command failed: security find-generic-password -s ${service} -w\nsecurity: SecKeychainSearchCopyNext: User canceled the operation.\n`);
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    expect(f.reads).toEqual(["gh:github.com"]);
    const note = out.indexOf("GitHub CLI login: Keychain read failed (security: SecKeychainSearchCopyNext: User canceled the operation.); changed to sign in on the machine.");
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(out.search(BOOT));
    // The refusal happened with no machine on the account; the pack later asks the Keychain for nothing and notes the row.
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "logins/gh")?.choice).toBe("machine");
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log.some(c => c.includes("tar xzf"))).toBe(true);
    // The refused row travels with none of its files: the recipe is replanned with gh as a sign-in, so the builder
    // carries two items fewer than first planned (hosts.yml and the Keychain item stay home) and the same hash a
    // reload of the saved recipe gives.
    expect(f.recipes).toHaveLength(2);
    expect(f.recipes[1]!.import!.files!.count).toBe(f.recipes[0]!.import!.files!.count - 2);
    const skipped = JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).files.skipped as { id: string }[];
    expect(skipped.filter(s => s.id === "logins/gh")).toEqual([]);
  });

  it("a gh row that carries hosts.yml alone copies the file and never asks the Keychain", async () => {
    const rows = FIXTURE.entries.filter(e => e.rung === "identity" || e.id === "logins/gh").map(e => (e.id === "logins/gh" ? { ...e, paths: ["~/.config/gh/hosts.yml"] } : e));
    const f = fake({ yes: true, collect: async () => ({ entries: rows }), recipe: async () => without(answeredCopy("gh"), "claude") });
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    oauth_token: gho_in_file\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.reads).toEqual([]);
    expect(f.text()).not.toContain("Keychain read failed");
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("copy");
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")).files.skipped).toEqual([]);
  });

  it("a create the provider refuses ends with nothing booted, not a machine gone", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.create = async () => {
        throw Object.assign(new Error("Insufficient credit"), { kind: "quota", status: 402 });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.text()).toContain("Insufficient credit");
    expect(f.text()).toContain("Nothing was booted. Run wsp init again");
    expect(f.text()).not.toContain("That machine is gone");
    expect(f.backends[0]!.machines).toHaveLength(0);
  });

  it("over ssh the address is printed with the forward line instead of opening a browser", async () => {
    const f = fake({ yes: true, env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" } });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.opened).toEqual([]);
    expect(f.text()).toContain("ssh -L 4400:127.0.0.1:4400");
  });

  it("a refused create for the account cap waits and retries, killing nothing", async () => {
    const f = fake({ yes: true });
    let refusals = 0;
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      const create = backend.create.bind(backend);
      backend.create = async spec => {
        if (refusals < 2) {
          refusals += 1;
          throw Object.assign(new Error("Sandbox limit reached"), { kind: "concurrency", status: 429 });
        }
        return create(spec);
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(refusals).toBe(2);
    expect(f.text()).toContain("at its machine cap");
    // The builder, then the seal's smoke fork and the first workspace.
    expect(f.backends[0]!.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_golden-v1", true], ["snap_golden-v1", false]]);
  });

  it("a failed upload reports the stage and the detail and exits 1 with no host", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("tar xzf") ? { exitCode: 2, stdout: "", stderr: "gzip: stdin: not in gzip format" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    expect(f.text()).toMatch(/Uploading your files failed/);
    expect(f.text()).toContain("not in gzip format");
  });

  it("a tool that fails is a warning in the stream, named on its own line, not the end of the build", async () => {
    const f = fake({ yes: true, recipe: async () => ticking("codex") });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("brew install yq") ? { exitCode: 1, stdout: "", stderr: "curl: no route" } : guestAnswer(cmd));
      f.backends.push(backend);
      f.recipes.push(recipe);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    // The tools and their shared deps; the failed formula is named alone.
    expect(out).toMatch(/Tools installed\s+5 installed, 1 failed/);
    expect(out).toMatch(/Agents installed\s+Claude Code, Codex installed/);
    expect(out).toContain("Ready");
    // The stage line is cut to the width; the names come back in full under the tally.
    const tally = out.slice(out.indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 7 installed, 1 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "yq failed: curl: no route",
    ]);
    expect(f.recipes[0]!.import?.node).toMatchObject({ floor: 16, agents: ["Codex"] });
  });

  it("a machine context that did not land is counted and named in the tally, not the end of the build", async () => {
    const f = fake({ yes: true, recipe: async () => ticking("codex") });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      // The person's files untar under /root; the context archive is the one untarred at the root. Only the builder refuses it.
      backend.execImpl = (m, cmd) => (m.spec.fromSnapshot === undefined && cmd.includes("tar xzf - -C '/' ") ? { exitCode: 2, stdout: "", stderr: "tar: etc/wsp: Cannot mkdir: Read-only file system\n" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    const tally = out.slice(out.indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 8 installed, 1 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "machine context failed: write failed: vault import untar failed (exit 2): tar: etc/wsp: Cannot mkdir: Read-only file system",
    ]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({ context: [], contextFailure: expect.stringMatching(/^write failed: vault import untar failed/) });
  });

  /** A build whose context write the builder refused once, so the results file carries contextFailure; the next init over the same store attaches and the retried write lands. */
  async function builtWithRefusedContextWrite() {
    const store = memoryStore();
    const shared = stubBackend();
    let refusals = 0;
    // The builder refuses the root untar once: the build's context write fails, the attach's lands.
    shared.execImpl = (m, cmd) => (m.spec.fromSnapshot === undefined && cmd.includes("tar xzf - -C '/' ") && refusals++ === 0 ? { exitCode: 2, stdout: "", stderr: "tar: etc/wsp: Cannot mkdir: Read-only file system\n" } : guestAnswer(cmd));
    const runtimeOver = (f: Fake) => (recipe: GoldenRecipe) => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    const first = fake({ yes: true });
    first.opts.runtime = runtimeOver(first);
    await bootedOnly(first);
    const resultsPath = join(dirname(first.opts.statePath), "golden-import.json");
    const built = JSON.parse(readFileSync(resultsPath, "utf8")) as { tools: unknown[]; agents: unknown[]; context: unknown[]; contextFailure?: string };
    expect(built).toMatchObject({ context: [], contextFailure: expect.stringMatching(/^write failed: vault import untar failed/) });
    expect(built.tools.length).toBeGreaterThan(0);
    expect(built.agents.length).toBeGreaterThan(0);
    const attach = async (): Promise<Fake> => {
      const f = fake({ yes: true, tty: false, home: first.opts.home, statePath: first.opts.statePath });
      f.opts.runtime = runtimeOver(f);
      await bootedOnly(f);
      expect(f.text()).toMatch(/Attaching to your earlier builder/);
      expect(shared.machines).toHaveLength(1);
      return f;
    };
    return { resultsPath, built, attach };
  }

  it("an attach whose retried context write lands takes the failure out of the saved result and keeps the build's tools and agents", async () => {
    const { resultsPath, built, attach } = await builtWithRefusedContextWrite();
    const f = await attach();
    expect(f.text()).not.toContain("could not be read");
    const after = JSON.parse(readFileSync(resultsPath, "utf8")) as typeof built;
    expect(after.contextFailure).toBeUndefined();
    expect(after.context).toEqual([]);
    expect(after.tools).toEqual(built.tools);
    expect(after.agents).toEqual(built.agents);
  });

  it("an attach whose retried write lands over a results file that no longer parses says the file was rewritten with the context alone", async () => {
    const { resultsPath, attach } = await builtWithRefusedContextWrite();
    writeFileSync(resultsPath, "{ not json");
    const f = await attach();
    expect(f.text()).toContain(`${resultsPath} could not be read; it was rewritten with the machine context alone.`);
    expect(JSON.parse(readFileSync(resultsPath, "utf8"))).toEqual({ context: [] });
  });

  it("a line on stderr while the stages animate is drawn by the stream, and a build that fails hands the streams back", async () => {
    const f = fake({ yes: true });
    const write = { out: f.io.output.write, err: f.io.stderr.write };
    let duringPrepare: { out: typeof f.io.output.write; err: typeof f.io.stderr.write } | undefined;
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => {
        if (!cmd.includes(GOLDEN_SETUP)) return guestAnswer(cmd);
        duringPrepare = { out: f.io.output.write, err: f.io.stderr.write };
        f.io.stderr.write("heartbeat for builder m1 not written: ETIMEDOUT\n");
        return { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" };
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(duringPrepare?.out).not.toBe(write.out);
    expect(duringPrepare?.err).not.toBe(write.err);
    expect(f.io.output.write).toBe(write.out);
    expect(f.io.stderr.write).toBe(write.err);
    const out = f.text();
    expect(out).toContain("│  heartbeat for builder m1 not written: ETIMEDOUT");
    expect(out.indexOf("heartbeat for builder m1")).toBeLessThan(out.indexOf("Installing agents failed"));
    // The line the terminal showed for a moment is kept in the run log as a note.
    const runLog = readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8").split("\n");
    expect(runLog.some(l => / note heartbeat for builder m1 not written: ETIMEDOUT$/.test(l))).toBe(true);
    expect(runLog.findIndex(l => l.includes("note heartbeat"))).toBeLessThan(runLog.findIndex(l => l.includes("stage failed")));
  });

  it("an agent failing ends the build: one line per agent with its reason, the builder killed, and an offer to start over", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes(GOLDEN_SETUP) ? { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toContain("Installing agents failed");
    expect(out.split("\n").map(l => l.replace(/^│\s+/, ""))).toEqual(expect.arrayContaining(["an agent did not install, so nothing is sealed:", "Claude Code: curl: (6) Could not resolve host"]));
    expect(out).toContain("Run wsp init again to start over; the recipe is kept.");
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({ agents: [{ id: "agents/claude", outcome: "failed" }] });
    // The terminal shows one line per agent; the log has the install's whole stderr under its exec, and the failure.
    const logPath = join(dirs[0]!, "init.log");
    expect(out).toContain(`The run log is ${logPath}`);
    const runLog = readFileSync(logPath, "utf8");
    expect(runLog).toContain("  ! curl: (6) Could not resolve host");
    expect(runLog).toMatch(/ note failed: an agent did not install, so nothing is sealed:\n/);
    expect(runLog).toMatch(/ stage failed: an agent did not install/);
  });

  it("a run log that cannot be written stops nothing: the address line says so instead of naming it", async () => {
    const f = fake({ yes: true, tty: false });
    mkdirSync(join(dirname(f.opts.statePath), "init.log"));
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.hosts).toBe(1);
    expect(f.text()).toMatch(/The run log .*init\.log could not be written \(EISDIR/);
    expect(f.text()).not.toContain("The run log is");
  });

  it("a Keychain value never reaches the run log, whatever the machine prints it in", async () => {
    const f = fake({ yes: true, tty: false });
    withGhCopy(f);
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd === "true" ? { exitCode: 0, stdout: "export GH_TOKEN=gho_fake\ntoken gho_fake seen\n", stderr: "" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    const runLog = readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8");
    expect(runLog).toContain("  > export GH_TOKEN=<redacted>");
    expect(runLog).toContain("  > token <redacted> seen");
    expect(runLog).not.toContain("gho_fake");
  });

  it("a builder from an earlier run built from a different recipe is listed with its age, cost and reason; under --yes it is stopped by its recorded id and a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const earlier = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096 } });
    await earlier.golden.prepare();
    const f = fake({ yes: true });
    withGhCopy(f);
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    expect(f.hosts).toBe(1);
    const out = f.text();
    expect(out).toContain("A builder from an earlier wsp init is still running on the account:");
    // A record with no digest behind its hash can say no more than this.
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe$/m);
    expect(out).toMatch(/Stop it, then boot a 2 vCPU, 4 GB builder on Solari and build this\? About \$0\.11\/hr while it runs\. Taken as yes \(--yes\)\./);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Solari console");
    expect(out).not.toContain("save it");
    // The stop comes after the consent dialog and right before the boot, so a refused dialog costs no machine.
    expect(f.reads).toEqual(["gh:github.com"]);
    expect(out.indexOf("Reading your Keychain")).toBeLessThan(out.indexOf("Stopped default (m1)."));
    expect(out.indexOf("Stopped default (m1).")).toBeLessThan(out.indexOf("Ready"));
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
    expect(await store.list("builders")).toHaveLength(1);
  });

  it("a changed byte in a planned file is named in the refusal; the earlier builder is stopped on the yes and a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=2\n");

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe: ~\/\.zshrc changed$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Attaching");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("a planned file rewritten with the same bytes and a moved mtime still attaches: the hash reads bytes, not stat times", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    const zshrc = join(first.opts.home, ".zshrc");
    writeFileSync(zshrc, readFileSync(zshrc));
    const later = new Date(Date.now() + 90_000);
    utimesSync(zshrc, later, later);

    const f = fake({ yes: true, tty: false, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    expect(out).not.toContain("still running on the account");
    expect(out).not.toMatch(BOOT);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a recipe saved before the volatile list existed still attaches once ~/.claude.json moved: the catalog supplies the list, the file is re-imported and never reads as gone", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    const home = first.opts.home;
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {} } }));
    const saved: Manifest = { entries: [
      { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 20, default: "bring", required: true },
      { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude/settings.json", "~/.claude.json"], bytes: 30, default: "bring" },
    ] };
    first.opts.collect = async () => saved;
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    const [recorded] = (await store.list("builders")) as { import: { recipe: { files: { path: string; volatile?: boolean }[] } } }[];
    expect(recorded!.import.recipe.files.map(f => [f.path, f.volatile])).toEqual([["~/.claude.json", true], ["~/.claude/settings.json", undefined], ["~/.gitconfig", undefined]]);

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {}, two: {} } }));
    const f = fake({ yes: true, tty: false, home, collect: async () => saved });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    expect(out).toMatch(/Files uploaded\s+~\/\.claude\.json re-imported/);
    expect(out).not.toContain("gone");
    expect(out).not.toContain("still running on the account");
    expect(shared.machines).toHaveLength(1);
  });

  it("a re-login on this computer attaches: the Keychain value is out of the hash, the login file re-renders with the new token on attach, and the record carries the new value's digest", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const keychainOf = async () => ((await store.list("builders")) as { import: { recipe: { files: { path: string; digest: string; volatile?: boolean }[] } } }[])[0]!.import.recipe.files.find(f => f.path === "Keychain: gh:github.com");
    expect(await keychainOf()).toMatchObject({ digest: sha("gho_fake"), volatile: true });
    // The person's files untar under /root; the machine context archive untars at the root and is not counted here.
    const uploads = () => shared.machines[0]!.execLog.filter(c => c.includes("tar xzf - -C '/root'")).length;
    expect(uploads()).toBe(1);

    const f = fake({ yes: true, tty: false, home: first.opts.home });
    withGhCopy(f);
    f.opts.secrets = { read: async () => "gho_new", run: async () => { throw new Error("no helper in this fixture"); } };
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    // The fake home has no hosts.yml, so the login file is rendered from the Keychain value alone.
    // Off a terminal the detail is cut at 80 columns; the path and the start of the word survive.
    expect(out).toMatch(/Files uploaded\s+Keychain: gh:github\.com re-imp/);
    expect(uploads()).toBe(2);
    expect(await keychainOf()).toMatchObject({ digest: sha("gho_new"), volatile: true });
    expect(shared.machines).toHaveLength(1);
  });

  it("when the second of two stops fails, the message names the builder still running", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    for (const n of [1, 2]) {
      const earlier = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096, labels: { n: String(n) } } });
      await earlier.golden.prepare();
    }
    expect(shared.machines.map(m => m.id)).toEqual(["m1", "m2"]);
    shared.machines[1]!.kill = async () => { throw new Error("provider said no"); };
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Stop them, then boot a 2 vCPU/);
    expect(out).toContain("Stopped default (m1).");
    expect(out).toContain("Stopping default (m2) failed: provider said no");
    expect(out).toContain("Nothing was booted. default (m2) is still running; run wsp init again to retry.");
    expect(out).not.toContain("It is still running");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("a changed tick is named in the refusal: the saved recipe with Codex ticked reads as Codex ticked", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);

    const f = fake({ yes: true, tty: false, home: first.opts.home, recipe: async () => ticking("codex") });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe: Codex ticked$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("No at the stop question leaves the earlier builder running, boots nothing, and keeps the recipe", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=2\n");

    const f = fake({ home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("Stop it, then boot");
    const ask = f.text().slice(f.text().lastIndexOf("A builder from an earlier"));
    expect(ask).toMatch(/built from a different recipe: GitHub CLI login unticked, ~\/\.zshrc changed/);
    expect(ask).toMatch(/No\s+costs\s+nothing;\s+nothing\s+is\s+stopped\s+and\s+the\s+recipe\s+is\s+kept/);
    expect(ask).toContain(`${S_RADIO_ACTIVE} No`);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    expect(f.hosts).toBe(0);
    expect(f.text()).toContain("Nothing was booted or stopped. The recipe is kept.");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", false]]);
  });

  it("a builder from an earlier run that was paused is listed as unsealable and stopped on the yes; a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    shared.machines[0]!.paused = true;

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    await bootedOnly(f);
    expect(f.hosts).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; cannot be sealed after a restart$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Solari console");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("an earlier builder wearing another setup's owner label is refused with those words, and nothing boots beside it", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    shared.machines[0]!.spec.labels!["wsp-owner"] = "h_other";

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; not this setup's builder/);
    expect(out).not.toContain("cannot be sealed");
    expect(out).toContain("Nothing was booted. It belongs to another wsp setup: stop it from there, or from the Solari console if it is yours and forgotten; then run wsp init again.");
    expect(out).not.toContain("Stop it");
    expect(f.reads).toEqual([]);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("when the only blocker is a builder another wsp process is using, the guard says to wait for or stop that process, never to kill the machine", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: process.ppid } });

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toMatch(new RegExp(`default \\(m1\\), \\d+ s old, about \\$\\d+\\.\\d\\d so far; in use by another wsp process \\(pid ${process.ppid}\\)`));
    expect(out).toContain(`Nothing was booted. Another wsp process (pid ${process.ppid}) is using it; wait for it or stop that process, then run wsp init again.`);
    expect(out).not.toContain("Stop it");
    expect(f.reads).toEqual([]);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a placeholder left mid-setup by a dead process is listed as unfinished, never attached to even on the same recipe, and stopped on the yes before a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const gate = new Promise<void>(() => {});
    const dying = fake({ yes: true });
    dying.opts.runtime = recipe => {
      dying.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: () => gate } });
    };
    void runInit(dying.opts, dying.io);
    await vi.waitFor(() => expect(shared.machines).toHaveLength(1));
    const record = (await store.get("builders", "m1")) as { building?: true; heldBy: { host: string; pid: number; heartbeat: string } };
    expect(record.building).toBe(true);
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: 999_999_999 } });

    const f = fake({ yes: true, home: dying.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    await bootedOnly(f);
    expect(f.hosts).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; its setup never finished$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Solari console");
    expect(out).not.toContain("Attaching");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("when another builder blocks, the one this run can reuse is named; the yes stops the blocker and attaches to it", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    const other = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096 } });
    await other.golden.prepare();

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    await bootedOnly(f);
    expect(f.hosts).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m2\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe$/m);
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; reusable by this run once the others are stopped/);
    expect(out).toMatch(/Stop it, then attach to your earlier builder default \(m1\), \d+ s old, about \$\d+\.\d\d so far\? Taken as yes \(--yes\)\./);
    expect(out).toContain("Stopped default (m2).");
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    expect(out).not.toMatch(BOOT);
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", false], ["m2", true]]);
  });

  it("a Keychain refusal rehashes the recipe the builder carries, so the next wsp init with the same answers attaches after a crash", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.secrets = {
      read: async service => {
        if (service.includes("gh")) throw new Error("User canceled");
        return "tok";
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      first.runtimes.push(rt);
      return rt;
    };
    await bootedOnly(first);
    expect(first.text()).toContain("changed to sign in on the machine");
    const saved = JSON.parse(readFileSync(recipePath(first.opts.statePath), "utf8")) as { entries: { id: string; choice?: string }[] };
    expect(saved.entries.find(e => e.id === "logins/gh")).toMatchObject({ choice: "machine" });
    // The runtime that prepared the builder is the one built after the refusal, around the rehashed recipe.
    expect(first.runtimes).toHaveLength(2);
    const [recorded] = (await store.list("builders")) as { import: { recipeHash: string } }[];
    expect(recorded!.import.recipeHash).toBe((await first.runtimes[1]!.golden.builders())[0]!.recipeHash);

    const f = fake({ yes: true, tty: false, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    expect(f.reads).toEqual([]);
    expect(f.text()).toContain("Attaching to your earlier builder: default (m1)");
    expect(shared.machines).toHaveLength(1);
  });

  it("a first-life builder from an earlier run with the same recipe is attached to: no boot question, every stage already applied, one machine", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    expect(shared.machines).toHaveLength(1);

    // The same home, so the file rows hash the same; a second process is a second runtime over the same
    // store. Off a terminal each stage prints once, so the lines can be counted.
    const f = fake({ yes: true, tty: false, home: first.opts.home });
    withGhCopy(f);
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    expect(f.hosts).toBe(1);
    const out = f.text();
    expect(out).toMatch(/Attaching to your earlier builder: default \(m1\), \d+ s old, about \$\d+\.\d\d so far\. Nothing new boots; stages already applied are skipped\./);
    expect(out).not.toMatch(BOOT);
    expect(out).not.toContain("Creating the machine");
    // The GitHub login is copied from the Keychain, so its rendered file goes up again on every attach; the rest is skipped.
    expect(out.match(/(Setup applied|Tools installed|Agents installed)\s+already applied/g)).toHaveLength(3);
    expect(out).toMatch(/Files uploaded\s+Keychain: gh:github\.com re-imp/);
    // The two stages an attach never runs say so as well, and no skipped stage carries a duration: the reach
    // check that follows the last one is nobody's stage.
    expect(out).toMatch(/Machine created\s+already applied$/m);
    expect(out).toMatch(/Base installed\s+already applied$/m);
    expect(out).not.toMatch(/already applied\s+\d/);
    expect(out).toContain("Ready");
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
    expect((await store.list("builders")).map(b => (b as { id: string; firstLife: boolean }).firstLife)).toEqual([true]);
  });

  it("the seal report names the version sealed: a second golden on the same store is v2", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const runtimeOver = (f: Fake) => (recipe: GoldenRecipe) => {
      f.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      f.runtimes.push(rt);
      return rt;
    };
    const first = fake({ yes: true, tty: false });
    first.opts.runtime = runtimeOver(first);
    expect((await runInit(first.opts, first.io)).code).toBe(0);
    expect(first.text()).toContain("Golden v1 sealed.");

    // The seal kept that builder for its window; a changed recipe updates the golden on it and seals v2 there.
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const second = fake({ yes: true, tty: false, home: first.opts.home });
    second.opts.runtime = runtimeOver(second);
    expect((await runInit(second.opts, second.io)).code).toBe(0);
    await second.until("Sealed");
    expect(second.text()).toMatch(/Golden v2 sealed in \d+s on the builder kept since the save/);
    expect(second.text()).not.toContain("Golden v1 sealed");
    // The kept builder and the first run's workspace.
    expect(shared.machines.filter(m => !m.killed).map(m => m.spec.fromSnapshot)).toEqual([undefined, "snap_golden-v1"]);
  });
});

describe("wsp init, a signal during prepare", () => {
  const gone = () => Object.assign(new Error("gone"), { kind: "missing", status: 404 });
  const SWEEP = "the next wsp or wsp init on this computer stops it, or stop it from the Solari console.";

  /** The tools stage hangs on its first install until the machine is deleted, as the provider fails a call on a machine that is gone;
   * the signal lands while that call is in flight. `onKill` sees the machine's kill before it runs. */
  function toolsStageHeld(f: Fake, store: ReturnType<typeof memoryStore>, onKill?: (m: StubMachine, kill: () => Promise<void>) => Promise<void>, signal: "SIGINT" | "SIGTERM" = "SIGINT"): void {
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (m, cmd) => {
        if (!cmd.includes("brew install yq")) return guestAnswer(cmd);
        return new Promise((_, reject) => {
          const kill = m.kill.bind(m);
          m.kill = async () => {
            if (onKill !== undefined) await onKill(m, kill);
            else await kill();
            reject(gone());
          };
          f.signals.emit(signal);
        });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    };
  }

  it.each([
    ["--yes", { yes: true }, "SIGINT", 130],
    ["no terminal", { yes: false, tty: false }, "SIGTERM", 143],
  ] as const)("a signal during the tools stage (%s) kills the builder by its recorded id, drops the record, says so on one line and exits", async (_label, over, signal, code) => {
    const f = fake(over);
    const store = memoryStore();
    toolsStageHeld(f, store, undefined, signal);
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(code);
    expect(f.exits).toEqual([code]);
    expect(f.hosts).toBe(0);
    expect(f.backends[0]!.machines.map(m => [m.id, m.killed])).toEqual([["m1", true]]);
    expect(await store.list("builders")).toEqual([]);
    const out = f.text();
    expect(out).toContain("Stopped while installing tools. Builder m1 is gone; nothing is billing.");
    expect(out).not.toContain("Installing tools failed");
    expect(out).not.toContain("Run wsp init again");
    expect(f.signals.listenerCount("SIGINT") + f.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("a signal during the stages hands the streams back with the stream it stops", async () => {
    const f = fake({ yes: true });
    const write = { out: f.io.output.write, err: f.io.stderr.write };
    let duringPrepare: typeof f.io.stderr.write | undefined;
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (m, cmd) => {
        if (!cmd.includes("brew install yq")) return guestAnswer(cmd);
        // The stream is animating here; the signal that follows stops it and must hand the streams back.
        duringPrepare = f.io.stderr.write;
        return new Promise((_, reject) => {
          const kill = m.kill.bind(m);
          m.kill = async () => {
            await kill();
            reject(gone());
          };
          f.signals.emit("SIGINT");
        });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(duringPrepare).toBeDefined();
    expect(duringPrepare).not.toBe(write.err);
    expect(f.io.output.write).toBe(write.out);
    expect(f.io.stderr.write).toBe(write.err);
  });

  it("a second signal while the kill is still running exits at once with the builder id and the sweep line; the record stays for the sweep", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    let killing!: () => void;
    const killStarted = new Promise<void>(r => {
      killing = r;
    });
    toolsStageHeld(f, store, async (_m, kill) => {
      killing();
      await held;
      await kill();
    });
    const run = runInit(f.opts, f.io);
    await killStarted;
    f.signals.emit("SIGINT");
    await vi.waitFor(() => expect(f.exits).toEqual([130]));
    expect(f.text()).toContain(`Stopping was cut short. Builder m1 may still be running; ${SWEEP}`);
    expect(await store.get("builders", "m1")).toMatchObject({ building: true, heldBy: { pid: process.pid } });
    expect(f.backends[0]!.machines[0]!.killed).toBe(false);
    release();
    expect((await run).code).toBe(130);
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
  });

  it("a signal while the create is still in flight waits for the machine, then kills it: nothing leaks", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      const create = backend.create.bind(backend);
      backend.create = spec => {
        f.signals.emit("SIGINT");
        return create(spec);
      };
      f.backends.push(backend);
      return createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.backends[0]!.machines.map(m => [m.id, m.killed])).toEqual([["m1", true]]);
    expect(await store.list("builders")).toEqual([]);
    expect(f.text()).toContain("Stopped while creating the machine. Builder m1 is gone; nothing is billing.");
    expect(f.exits).toEqual([130]);
  });

  it("a signal during the wait for a machine slot cuts the wait: nothing was booted", async () => {
    const f = fake({ yes: true, retry: { waitMs: 60_000, attempts: 3 } });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.create = async () => {
        throw Object.assign(new Error("Sandbox limit reached"), { kind: "concurrency", status: 429 });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const run = runInit(f.opts, f.io);
    await f.until("at its machine cap");
    f.signals.emit("SIGINT");
    const result = await run;
    expect(result.code).toBe(130);
    expect(f.backends[0]!.machines).toHaveLength(0);
    expect(f.text()).toContain("Stopped while waiting for a machine slot. Nothing was booted; nothing is billing.");
    expect(f.exits).toEqual([130]);
  });

  it("a builder that outlives its kill is named with the sweep line, and its record stays for the sweep", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    toolsStageHeld(f, store, async () => {
      throw new Error("provider said no");
    });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.text()).toContain(`Stopped while installing tools. Builder m1 did not stop (provider said no); ${SWEEP}`);
    expect(f.text()).not.toContain("nothing is billing");
    expect(await store.get("builders", "m1")).toMatchObject({ building: true });
    expect(f.exits).toEqual([130]);
  });

  it("a second signal while the stop's line, close and exit run still answers, with the line the stop settled on", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    toolsStageHeld(f, store);
    const exit = f.io.exit;
    f.io.exit = code => {
      exit(code);
      if (f.exits.length === 1) f.signals.emit("SIGINT");
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.exits).toEqual([130, 130]);
    expect(f.text().match(/Stopped while installing tools\. Builder m1 is gone; nothing is billing\./g)).toHaveLength(2);
    expect(f.text()).not.toContain("cut short");
  });

  it("a last exec that outruns the kill never writes a finished record: the placeholder stays building until the stop drops it", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    const puts: { id: string; building?: true }[] = [];
    const put = store.put.bind(store);
    store.put = async (collection, id, value) => {
      if (collection === "builders") puts.push({ id, ...(value as { building?: true }) });
      return put(collection, id, value);
    };
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    let ready!: () => void;
    const prepared = new Promise<void>(r => {
      ready = r;
    });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (m, cmd) => {
        // The signal lands inside the agents install, which then finishes on its own; the kill waits until told.
        if (cmd.includes(GOLDEN_SETUP)) {
          const kill = m.kill.bind(m);
          m.kill = async () => {
            await held;
            await kill();
          };
          f.signals.emit("SIGINT");
        }
        return guestAnswer(cmd);
      };
      f.backends.push(backend);
      const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
      rt.events.on("golden.stage", e => {
        if (e.type === "golden.stage" && e.stage === "ready") ready();
      });
      return rt;
    };
    const run = runInit(f.opts, f.io);
    await prepared;
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every(p => p.building === true)).toBe(true);
    release();
    expect((await run).code).toBe(130);
    expect(puts.every(p => p.building === true)).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
    expect(f.text()).toContain("Builder m1 is gone; nothing is billing.");
  });

  it("a signal while attaching to an earlier first-life builder leaves it running: the hold is released, the record stays reusable, and the line says what bills", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    expect(shared.machines).toHaveLength(1);

    const f = fake({ yes: true, home: first.opts.home });
    withGhCopy(f);
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      // The attach's liveness check never answers; the signal lands while it is in flight.
      shared.execImpl = (_m, cmd) => {
        if (cmd !== "true") return guestAnswer(cmd);
        f.signals.emit("SIGINT");
        return new Promise<never>(() => {});
      };
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.exits).toEqual([130]);
    expect(f.hosts).toBe(0);
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", false]]);
    const record = (await store.get("builders", "m1")) as { firstLife: boolean; building?: true; heldBy?: unknown };
    expect(record).toMatchObject({ firstLife: true });
    expect(record.building).toBeUndefined();
    expect(record.heldBy).toBeUndefined();
    const out = f.text();
    expect(out).toMatch(/Stopped between stages\. Your earlier builder default \(m1\) was not stopped: it has a first life worth keeping and stays up at about \$\d+\.\d\d\/hr\. wsp init --recipe .*recipe\.json attaches to it again; the sweep stops it once it is six hours old\./);
    expect(out).not.toContain("nothing is billing");
  });

  it("once init returns no handler of init's is left: a signal then is the host's to handle", async () => {
    const f = fake({ yes: true });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.hosts).toBe(1);
    expect(f.signals.listenerCount("SIGINT") + f.signals.listenerCount("SIGTERM")).toBe(0);
    f.signals.emit("SIGINT");
    expect(f.exits).toEqual([]);
    expect(f.backends[0]!.machines[0]!.killed).toBe(false);
  });
});

describe("summaryNote", () => {
  it("the Machine disk line adds files, Homebrew's toolchain, the formulae's closures and the agents against the room, and names what has no size", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/yq", "tools/npm/tsx", "agents/claude", "agents/codex"]);
    const brew = new Map([
      ["gh", { name: "gh", fullName: "gh", deps: [], bytes: 50 * 1024 * 1024, macosOnly: false }],
      ["yq", { name: "yq", fullName: "yq", deps: ["oniguruma"], bytes: 2 * 1024 * 1024, macosOnly: false }],
      ["oniguruma", { name: "oniguruma", fullName: "oniguruma", deps: [], bytes: 1024 * 1024, macosOnly: false }],
    ]);
    const lines = summaryNote(FIXTURE, ticks, new Map(), 200, 300 * 1024 * 1024, brew);
    // 300 MB files + 1024 toolchain + 53 tools + 663 agents + 50 assumed for tsx = 2090 MiB.
    expect(lines).toContain("Disk      2.0 GB of 15.2 GB on the 20 GB builder (files 300.0 MB, Homebrew's toolchain 1.0 GB, tools 53.0 MB, agents 663.0 MB; 1 unmeasured, ~50.0 MB)");
    const huge = new Map([["gh", { name: "gh", fullName: "gh", deps: [], bytes: 30 * 1024 * 1024 * 1024, macosOnly: false }]]);
    const over = summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0, huge).find(l => l.startsWith("Disk"));
    expect(over).toBe("Disk      31.0 GB, 15.8 GB over the 15.2 GB the 20 GB builder leaves (Homebrew's toolchain 1.0 GB, tools 30.0 GB)");
    // With colour on, the Disk line takes its tier's colour, every wrapped line of it; a total under 50 percent stays plain.
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    try {
      const wrapped = summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 90, 0, huge).filter(l => stripVTControlCharacters(l).startsWith("Disk") || stripVTControlCharacters(l).startsWith("          "));
      expect(wrapped.length).toBeGreaterThan(1);
      for (const l of wrapped) expect(l).toMatch(/^\x1b\[31m.*\x1b\[39m$/);
      expect(summaryNote(FIXTURE, ticks, new Map(), 200, 300 * 1024 * 1024, brew).find(l => l.startsWith("Disk"))).not.toContain("\x1b[");
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("names every row outside the catalog with the command it runs, since the card is the last thing read before the boot", () => {
    const custom = [
      { kind: "custom" as const, id: "brew/just", name: "just", install: ["brew install just"], check: "command -v just", size: 4 * 1024 * 1024, why: "installed on this Mac by brew" },
      { kind: "custom" as const, id: "ruff", name: "ruff", install: ["uv tool install ruff"], check: "ruff --version", why: "used in wsp" },
    ];
    const lines = summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0, new Map(), custom);
    expect(lines).toContain("Added     just runs brew install just");
    expect(lines).toContain("          ruff runs uv tool install ruff");
    // They are the person's tools too: the Installs line counts them, the Disk line carries the measured one's
    // 4 MB and counts the other beside the gh formula the Mac's Homebrew never sized.
    expect(lines.find(l => l.startsWith("Installs"))).toContain("3 tools");
    expect(lines.find(l => l.startsWith("Disk"))).toContain("tools 4.0 MB; 2 unmeasured");
    expect(summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0).some(l => l.startsWith("Added"))).toBe(false);
  });

  it("a tap formula that takes the road counts as a tool in the Installs line, with the checksum note the ruling asks for", () => {
    const tap = { rung: "tools" as const, id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "bring" as const, linux: "unknown" as const };
    const brew = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * 1024 * 1024, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const manifest = { entries: [...FIXTURE.entries, tap] };
    const ticks = new Set(["tools/brew/gh", "tools/brew/zingzy/tap/diskbloom", "agents/claude"]);
    const fresh = summaryNote(manifest, ticks, new Map(), 200, 0, brew);
    expect(fresh).toContain("Installs  Claude Code, 2 tools plus Homebrew's toolchain, 1 from its GitHub release (checksum recorded on first install)");
    // Without the table the tap is a skip, as init-import would plan it without the table too.
    expect(summaryNote(manifest, ticks, new Map(), 200, 0)).toContain("Installs  Claude Code, 1 tool plus Homebrew's toolchain");
    const pinned = summaryNote({ entries: [...FIXTURE.entries, { ...tap, pin: { tag: "v0.1.0", sha256: "f".repeat(64) } }] }, ticks, new Map(), 200, 0, brew);
    expect(pinned).toContain("Installs  Claude Code, 2 tools plus Homebrew's toolchain, 1 from its GitHub release (checksum checked against the first install)");
    // The Mac's tap moved on to a newer tag since the pin: an ordinary upgrade, recorded again, not a mismatch.
    const moved = summaryNote({ entries: [...FIXTURE.entries, { ...tap, pin: { tag: "v0.0.9", sha256: "f".repeat(64) } }] }, ticks, new Map(), 200, 0, brew);
    expect(moved).toContain("Installs  Claude Code, 2 tools plus Homebrew's toolchain, 1 from its GitHub release (new release, checksum recorded)");
  });

  it("wraps a long Installs line under its own column instead of letting the frame break it with a stray indent", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/yq", "tools/npm/tsx", "agents/claude"]);
    const narrow = summaryNote(FIXTURE, ticks, new Map(), 48);
    const at = narrow.indexOf("Installs  Claude Code, 3 tools plus");
    expect(at).toBeGreaterThan(-1);
    expect(narrow[at + 1]).toBe("          Homebrew's toolchain");
    // The card's bar takes three columns; every line fits inside what is left.
    expect(narrow.every(l => l.length <= 48 - CARD_FRAME)).toBe(true);
    expect(summaryNote(FIXTURE, ticks, new Map(), 80)).toContain("Installs  Claude Code, 3 tools plus Homebrew's toolchain");
  });

  it("the card prints the pre-wrapped lines one for one, none past the columns, so nothing is wrapped twice", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/yq", "tools/npm/tsx", "agents/claude"]);
    for (const columns of [50, 80]) {
      const output = Object.assign(new PassThrough(), { columns });
      const chunks: string[] = [];
      output.on("data", (c: Buffer) => chunks.push(c.toString()));
      const lines = summaryNote(FIXTURE, ticks, new Map(), widthOf(output));
      card("Summary", lines, output);
      const printed = stripVTControlCharacters(chunks.join("")).split("\n");
      expect(printed.filter(l => l.length > columns)).toEqual([]);
      // Past the bar and the title line, each printed line is one of ours, with the bar's three columns before it.
      expect(printed.slice(2, -1).map(l => l.replace(/^│( {2})?/, ""))).toEqual(lines);
      // At 50 the Installs line had to wrap, so the one-to-one check above saw a continuation line go through.
      if (columns === 50) expect(lines.some(l => l.startsWith(" ".repeat(10)) && l.trim() !== "")).toBe(true);
    }
  });
});

describe("stage stream", () => {
  const ev = (stage: string, detail?: string) => ({ type: "golden.stage" as const, name: "default", stage, ...(detail !== undefined ? { detail } : {}) });

  it("renders one step per stage named, in the frames' order, with start and end labels and a tail of details", () => {
    const view = reduceStages([ev("creating", "sandbox from default"), ev("deploying-daemon", "node v22"), ev("installing-harness")]);
    expect(view.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["deploying-daemon", "done"],
      ["installing-harness", "current"],
    ]);
    expect(view.steps.map(s => [s.start, s.end])).toEqual([
      ["Creating the machine", "Machine created"],
      ["Installing the base (tools and daemon)", "Base installed"],
      ["Installing agents", "Agents installed"],
    ]);
    expect(view.steps[0]).toMatchObject({ tail: ["sandbox from default"] });
    expect(view.steps[1]!.tail).toEqual(["node v22"]);
    expect(view.failure).toBeUndefined();
  });

  it("a stage never named never shows; ready finishes; failed carries the detail", () => {
    const done = reduceStages([ev("creating"), ev("installing-harness"), ev("ready")]);
    expect(done.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["installing-harness", "done"],
      ["ready", "done"],
    ]);
    const failed = reduceStages([ev("creating"), ev("failed", "golden setup failed (exit 1): curl: no route")]);
    expect(failed.steps.map(s => [s.stage, s.state])).toEqual([["creating", "failed"]]);
    expect(failed.failure).toBe("golden setup failed (exit 1): curl: no route");
  });

  it("a step closes only when another stage's frame arrives, whatever order the engine runs them in", () => {
    const view = reduceStages([ev("creating"), ev("uploading-files"), ev("installing-harness"), ev("installing-harness", "claude (1/3)"), ev("installing-tools", "gh (1/2)")]);
    expect(view.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["uploading-files", "done"],
      ["installing-harness", "done"],
      ["installing-tools", "current"],
    ]);
    expect(view.steps.filter(s => s.state === "current")).toHaveLength(1);
  });

  it("a frame's arrival time gives the stage it ends its duration; the last stage has none", () => {
    const view = reduceStages([
      { ...ev("creating"), at: 1_000 },
      { ...ev("deploying-daemon"), at: 4_200 },
      { ...ev("deploying-daemon", "node v22"), at: 4_900 },
      { ...ev("installing-tools"), at: 5_000 },
      { ...ev("ready"), at: 65_500 },
    ]);
    // The second deploying-daemon frame carries the detail; it does not restart that stage's clock.
    expect(view.steps.map(s => s.ms)).toEqual([3_200, 800, 60_500, undefined]);
  });

  it("a stage already applied is done the moment its frame arrives and is charged no time, whatever follows it", () => {
    const skipped = ["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"].map((stage, i) => ({ ...ev(stage, ALREADY_APPLIED), at: 1_000 + i }));
    const view = reduceStages([...skipped, { ...ev("ready"), at: 2_200 }]);
    expect(view.steps.map(s => s.state)).toEqual(Array<string>(8).fill("done"));
    expect(view.steps.map(s => s.ms)).toEqual(Array<undefined>(8).fill(undefined));
    expect(view.steps.slice(0, 7).map(s => s.tail)).toEqual(Array<string[]>(7).fill(["already applied"]));
  });

  it("a failure with nothing running lands on the stage about to run, not on the last stage the builder already held", () => {
    const skipped = ["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-tools", "installing-harness", "installing-mcp"].map(stage => ev(stage, ALREADY_APPLIED));
    const view = reduceStages([...skipped, ev("failed", "the builder answered exit 1 to a no-op; it is not serving")]);
    expect(view.steps.map(s => s.state)).toEqual([...Array<string>(7).fill("done"), "failed"]);
    expect(view.steps[7]!.fail).toBe("The machine never became ready");
    expect(view.failure).toBe("the builder answered exit 1 to a no-op; it is not serving");
    // A failure while a stage runs still lands on that stage.
    const running = reduceStages([ev("creating"), ev("uploading-files", "4 MB"), ev("failed", "HTTP 413")]);
    expect(running.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["uploading-files", "failed"],
    ]);
  });

  it("a stage line pads the label, keeps the detail, and puts the duration flush right at the width", () => {
    const line = stripVTControlCharacters(stageLine("o", "Base installed", "node v22.12.0", 3_200, 60, 20));
    expect(line).toBe("o  Base installed        node v22.12.0                  3.2s");
    expect(line.length).toBe(60);
    const long = stripVTControlCharacters(stageLine("o", "Base installed", "x".repeat(80), 61_000, 60, 20));
    expect(long.length).toBe(60);
    expect(long).toMatch(/x…  1m 1s$/);
    expect(stripVTControlCharacters(stageLine("o", "Ready", undefined, undefined, 60, 20))).toBe("o  Ready");
    // Off a terminal there is no width: nothing is cut and the duration follows two spaces after the detail.
    expect(stripVTControlCharacters(stageLine("o", "Base installed", "x".repeat(80), 61_000, undefined, 20))).toBe(`o  Base installed        ${"x".repeat(80)}  1m 1s`);
  });

  it("frames for another golden are ignored", () => {
    const view = reduceStages([{ type: "golden.stage" as const, name: "nightly", stage: "ready" }]);
    expect(view.steps).toEqual([]);
  });
});

describe("pack size before the boot", () => {
  it("a recipe whose files would not fit the machine's disk is refused after the summary, before anything boots", async () => {
    // Under the disk estimate's room, over what the upload stage can hold twice (the archive and its files).
    const big = 9 * 1024 * 1024 * 1024;
    const f = fake({ yes: true, collect: async () => ({ entries: FIXTURE.entries.map(e => (e.id === "shell/zshrc" ? { ...e, bytes: big } : e)) }) });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toMatch(/Upload\s+9\.0 GB, over the 8\.5 GB the machine's disk allows/);
    expect(out).not.toContain("This recipe needs about");
    expect(out).toContain("Recipe saved to");
    expect(out).toContain("Nothing was booted.");
    // No screen lists the files; the saved manifest does, and the fix is on this computer.
    expect(out).toContain(`The rows and their sizes are listed in ${recipePath(f.opts.statePath)}; shrink or remove the largest on this computer and run wsp init again.`);
    expect(out).not.toMatch(BOOT);
    expect(f.backends[0]?.machines ?? []).toHaveLength(0);
    expect(f.hosts).toBe(0);
  });
});

describe("disk estimate before the boot", () => {
  it("the first install of a release tag records the tag and the asset's checksum into the recipe file", async () => {
    // gh with no formula row here: the recipe's bare row installs it from its GitHub release.
    const f = fake({ yes: true, collect: async () => ({ entries: FIXTURE.entries.filter(e => e.id !== "tools/brew/gh") }) });
    const sha = "b".repeat(64);
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("repos/cli/cli/releases/latest") ? { exitCode: 0, stdout: `WSP_ROAD release gh_2.86.0_linux_amd64.tar.gz ${sha} v2.86.0\n`, stderr: "" } : guestAnswer(cmd));
      f.backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      f.runtimes.push(rt);
      return rt;
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    // The road command ran without a check: nothing was recorded before.
    const road = f.backends[0]!.machines[0]!.execLog.find(c => c.includes("repos/cli/cli/releases/latest"))!;
    expect(road).not.toContain('[ "$sum" =');
    const saved = loadManifest(recipePath(f.opts.statePath));
    expect(saved.entries.find(e => e.id === "tools/catalog/gh")?.pin).toEqual({ tag: "v2.86.0", sha256: sha });
    expect(saved.entries.filter(e => e.pin !== undefined)).toHaveLength(1);
    // The results file carries the same checksum and tag beside the road.
    const results = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { tools: { id: string; road?: { kind: string; sha256?: string } }[] };
    expect(results.tools.find(t => t.id === "tools/catalog/gh")?.road).toEqual({ kind: "release", from: "gh_2.86.0_linux_amd64.tar.gz", sha256: sha, tag: "v2.86.0" });
  });

  it("the tally after the build names every skipped tool with its reason, under the counts, and the results file carries the same rows", async () => {
    // A catalog formula this Mac has with no Linux bottle known: ticked by the recipe, set aside by the plan.
    const unknown: ManifestEntry = { rung: "tools", id: "tools/brew/maven", label: "maven", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" };
    const f = fake({ yes: true, collect: async () => ({ entries: [...FIXTURE.entries, unknown] }), recipe: async () => ticking("maven"), brew: async () => new Map() });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const tally = f.text().slice(f.text().indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 7 installed, 0 failed, 1 skipped; the list is in .*golden-import\.json$/),
      "maven skipped: no Linux bottle known",
    ]);
    const results = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { tools: { id: string; label: string; outcome: string; note?: string }[] };
    expect(results.tools.filter(t => t.outcome === "skipped")).toEqual([{ id: "tools/brew/maven", label: "maven", outcome: "skipped", note: "no Linux bottle known" }]);
  });

  it("a Homebrew that cannot be read is a note, not a stop; the summary falls back to the measured table", async () => {
    const f = fake({ yes: true, brew: async () => { throw new Error("brew: command timed out"); } });
    const run = runInit(f.opts, f.io);
    await f.until(BOOT);
    expect(f.text()).toContain("Homebrew could not be read for sizes (brew: command timed out); formula sizes come from the measured table alone.");
    expect(f.text()).toMatch(/Disk\s+1\.4 GB of 15\.2 GB/);
    await run;
  });
});

describe("wsp init with a golden already built from a recipe", () => {
  /** A first init under --yes that prepared and sealed golden v1; the builder stays for its window. Its first
   * workspace is refused by the host fake so the machines here are the builder and the forks the seals boot. */
  async function sealed(over: Partial<InitOptions> = {}) {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true, ...over });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      first.runtimes.push(rt);
      return rt;
    };
    first.opts.host = quietHost();
    expect((await runInit(first.opts, first.io)).code).toBe(0);
    expect(first.text()).toContain("Golden v1 sealed.");
    expect(first.text()).toContain("The first workspace could not be forked: no workspace in this fixture. Create one from the app.");
    const builder = shared.machines[0]!;
    await first.runtimes.at(-1)!.close();
    expect(builder.killed).toBe(false);
    expect(await store.get("golden-recipes", "default@v1")).toBeDefined();
    const next = (o: Partial<InitOptions> & { tty?: boolean } = {}) => {
      const f = fake({ yes: true, home: first.opts.home, statePath: first.opts.statePath, ...o });
      f.opts.runtime = recipe => {
        f.backends.push(shared);
        const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
        f.runtimes.push(rt);
        return rt;
      };
      return f;
    };
    return { store, shared, first, next };
  }

  it("--yes with a small change: the changes since v1 are listed, the update runs on the kept builder with the one sentence, v2 is current, and no machine boots", async () => {
    const { store, shared, first, next } = await sealed();
    const before = JSON.parse(readFileSync(join(dirname(first.opts.statePath), "golden-import.json"), "utf8")) as { recipeHash: string; build: unknown };
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ tty: false });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toContain("Changes since golden v1");
    expect(out).toContain("update 1 file: ~/.zshrc");
    expect(out).toContain("Small change: update on the builder kept since the save, under a minute");
    expect(out).toMatch(/about \$0\.11\/hr/);
    expect(out).toContain("Updating the golden. Taken as the default (--yes).");
    expect(out.match(/Updating the golden to v2: files, tools, agents and logins on it are kept and only the changes above are applied; workspaces on v1 stay there until you upgrade them\./g)).toHaveLength(1);
    expect(out).not.toMatch(BOOT);
    expect(out).not.toContain("A builder from an earlier wsp init is still running");
    for (const step of ["Machine ready", "Changes applied", "Files uploaded", "Tools installed", "Agents installed", "MCP servers installed", "Ready", "Snapshot taken", "Fork booted and checked", "Sealed"]) expect(out).toContain(step);
    expect(out).toContain("your builder from v1, kept since the save");
    expect(out).toMatch(/Golden v2 sealed in \d+s on the builder kept since the save; new workspaces fork it\./);
    expect(out).toContain("The builder stays up (about $0.11/h, one of the account's machine slots) until wsp init updates on it again, a wsp sweep stops it ten minutes after the save, or the provider's six-hour idle kill fires.");
    // The builder, v1's smoke fork, v2's smoke fork: nothing else booted.
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_golden-v1", true], ["snap_golden-v2", true]]);
    // The update rewrote the import result; the first build's measured stages stay in it for the next rebuild offer.
    const after = JSON.parse(readFileSync(join(dirname(first.opts.statePath), "golden-import.json"), "utf8")) as { recipeHash: string; build: unknown };
    expect(after.recipeHash).not.toBe(before.recipeHash);
    expect(after.build).toEqual(before.build);
    expect(await store.get("goldens", "default")).toMatchObject({ head: 2 });
    // The update kept the golden's disk, so what v1's sign-in stage recorded (both skipped under --yes) is stamped on v2 as it was.
    const skipped = [{ name: "GitHub CLI login", state: "skipped" }, { name: "Claude Code login", state: "skipped" }];
    expect(((await store.get("goldens", "default")) as { versions: { logins?: unknown }[] }).versions.map(v => v.logins)).toEqual([skipped, skipped]);
    expect(await store.get("golden-recipes", "default@v2")).toBeDefined();
    // The saved recipe is the new one, and a run on the same answers finds nothing to update.
    const again = next({ tty: false });
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toContain("Golden v2 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(shared.machines).toHaveLength(3);
  });

  /** The recipe with yq off: the formula this Mac has comes off the golden on the next update. */
  const withoutYq = (): Recipe => ({ ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "yq" ? { ...r, on: false } : r)) });

  it("a binary row unticked after the seal is retired on the update, left on the image, and the tally names it", async () => {
    const { store, shared, next } = await sealed();
    const f = next({ tty: false, recipe: async () => withoutYq() });
    const builder = shared.machines[0]!;
    const before = builder.execLog.length;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Builds version 2 on top of version 1: 1 row retired");
    expect(out).toContain("retire 1 tool: yq, left on the image");
    expect(out).toContain("Small change: update on the builder kept since the save");
    const ran = builder.execLog.slice(before);
    expect(ran.filter(c => c.includes("brew uninstall yq"))).toEqual([]);
    expect(ran.some(c => c.includes("brew install"))).toBe(false);
    expect(out).toMatch(/Golden v2 sealed in \d+s on the builder kept since the save/);
    expect(out).toMatch(/Tools, agents and machine context: 0 installed, 1 retired, 0 failed, 0 skipped; the list is in .*golden-import\.json/);
    expect(out).toContain("yq retired: out of the recipe, left on the image");
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({ tools: [], retired: [{ id: "tools/brew/yq", name: "yq" }] });
    expect(await store.get("goldens", "default")).toMatchObject({ head: 2, versions: [{ version: 1 }, { version: 2, retired: [{ id: "tools/brew/yq", name: "yq" }] }] });
  });

  it("when the cap refuses the smoke fork the update falls back and the line about the builder staying up is not printed", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const create = shared.create.bind(shared);
    let refused = false;
    shared.create = async spec => {
      if (spec.fromSnapshot === "snap_golden-v2" && !refused) {
        refused = true;
        throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      }
      return create(spec);
    };
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Golden v2 sealed in \d+s on the builder kept since the save; new workspaces fork it\./);
    expect(out).not.toContain("The builder stays up");
    expect(out).toContain("Run wsp to serve.");
    expect(shared.machines[0]!.killed).toBe(true);
  });

  it("the seal report names the kept builder only when it was kept: a cap fallback prints no such line", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const create = shared.create.bind(shared);
    // The account has one slot: a fork beside a running machine is refused, so the seal gives the builder up first.
    shared.create = async spec => {
      if (spec.fromSnapshot !== undefined && shared.machines.filter(m => !m.killed).length >= 1) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      return create(spec);
    };
    const f = fake({ yes: true, tty: false });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      f.runtimes.push(rt);
      return rt;
    };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("Golden v1 sealed.");
    expect(f.text()).not.toContain("The builder stays up ten minutes");
    expect(shared.machines[0]!.killed).toBe(true);
    // With the builder gone the first workspace fits the slot.
    expect(f.text()).toMatch(/Workspace first \(ws_[0-9a-f]+\) forked from golden v1\./);
  });

  it("a reusable builder already carrying the new recipe is attached to; the update road does not run beside it", async () => {
    const { shared, next } = await sealed();
    // A rebuild with the new recipe whose seal was answered no: its builder stays, first-life, carrying the new hash.
    const rebuilt = next({ recipe: async () => ticking("codex"), yes: false, tty: true });
    rebuilt.opts.host = quietHost();
    const run = runInit(rebuilt.opts, rebuilt.io);
    await throughScreens(rebuilt);
    await rebuilt.until("How do you want to apply them?");
    await rebuilt.press(KEY.enter);
    await rebuilt.until(BOOT);
    await rebuilt.press("y");
    await rebuilt.until(SEAL_Q(2));
    await rebuilt.press("n");
    expect((await run).code).toBe(1);
    expect(rebuilt.text()).toContain("Nothing was sealed. Builder m3 stays up");
    expect(shared.machines.map(m => m.killed)).toEqual([true, true, false]);
    await rebuilt.runtimes.at(-1)!.close();

    const again = next({ recipe: async () => ticking("codex"), tty: false });
    again.opts.host = quietHost();
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    const out = again.text();
    expect(out).toContain("Attaching to your earlier builder: default (m3)");
    expect(out).not.toContain("Changes since golden v1");
    expect(out).not.toMatch(BOOT);
    expect(out).toContain("Golden v2 sealed.");
    // The attached builder, kept by its seal, and v2's smoke fork.
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_golden-v1", true], [undefined, false], ["snap_golden-v2", true]]);
  });

  it("a failed update on the kept builder says that builder is gone and what a retry costs", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    shared.execImpl = (m, cmd) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: "1\n", stderr: "" } : guestAnswer(cmd));
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain("Golden v1 is unchanged and the builder kept since the save is gone. Run wsp init again to retry on a fork of the golden (about two minutes), or pick the rebuild.");
    expect(shared.machines[0]!.killed).toBe(true);
  });

  it("an unchanged recipe says the golden already matches and boots nothing", async () => {
    const { shared, next } = await sealed();
    const f = next();
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("Golden v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(f.text()).not.toContain("Changes since");
    expect(f.hosts).toBe(0);
    expect(shared.machines).toHaveLength(2);
  });

  it("a rebuild's seal offers the oldest version for deletion the way an update's does, before the app opens", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const second = next({ tty: false });
    expect((await runInit(second.opts, second.io)).code).toBe(0);
    expect(second.text()).toMatch(/Golden v2 sealed in \d+s/);
    // A big change takes the rebuild road; its seal is v3, so v1 is the one to offer.
    const third = next({ recipe: async () => ticking("codex"), tty: false });
    third.opts.host = quietHost();
    expect((await runInit(third.opts, third.io)).code).toBe(0);
    const out = third.text();
    expect(out).toContain("Rebuilding from scratch. Taken as the default (--yes).");
    expect(out).toContain("Golden v3 sealed.");
    expect(out).toMatch(/Delete golden v1, [\d.]+ GB, .*\? v3 and v2 stay\..* Taken as yes \(--yes\)\./);
    expect(out).toContain("Deleted golden v1.");
    expect(out.indexOf("Golden v3 sealed.")).toBeLessThan(out.indexOf("Delete golden v1"));
    expect(out.indexOf("Deleted golden v1.")).toBeLessThan(out.indexOf("Open http://"));
    expect(shared.snapshots.map(r => r.id)).toEqual(["snap_golden-v2", "snap_golden-v3"]);
  });

  it("once a third version seals, wsp init offers the oldest for deletion in one line and --yes takes it, keeping the head and its parent", async () => {
    const { store, shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const second = next({ tty: false });
    expect((await runInit(second.opts, second.io)).code).toBe(0);
    // Two versions: nothing to offer yet.
    expect(second.text()).not.toContain("Delete golden");
    expect(shared.snapshots.map(r => r.id)).toEqual(["snap_golden-v1", "snap_golden-v2"]);
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\nexport C=3\n");
    const third = next({ tty: false });
    expect((await runInit(third.opts, third.io)).code).toBe(0);
    const out = third.text();
    expect(out).toMatch(/Golden v3 sealed in \d+s/);
    expect(out).toContain("Delete golden v1, 8.0 GB, saving about $0.40/month from 2026-10-01? v3 and v2 stay. Taken as yes (--yes).");
    expect(out).toContain("Deleted golden v1.");
    expect(out).toContain("storage: 2 snapshots, 16.0 GB; about $0.30/month above the free 10 GB from 2026-10-01");
    expect(shared.snapshots.map(r => r.id)).toEqual(["snap_golden-v2", "snap_golden-v3"]);
    expect(await store.get("goldens", "default")).toMatchObject({ head: 3, versions: [{ version: 2 }, { version: 3 }] });
    expect(await store.get("golden-recipes", "default@v1")).toBeUndefined();
    expect(await store.get("golden-recipes", "default@v3")).toBeDefined();
  });

  it("a recipe with one row added builds the next version on top of the golden's head: one road only, v2 with v1 as its parent, and the wizard says what it builds", async () => {
    const { store, shared, first, next } = await sealed();
    const f = next({ tty: false, recipe: async () => ticking("tmux") });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Builds version 2 on top of version 1: 1 tool added");
    expect(out).toContain("Updating the golden. Taken as the default (--yes).");
    // One road: the delta landed on the builder kept from v1, and nothing was built from scratch beside it.
    expect(out).not.toContain("Rebuilding from scratch");
    expect(out).not.toMatch(BOOT);
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_golden-v1", true], ["snap_golden-v2", true]]);
    const manifest = (await store.get("goldens", "default")) as GoldenManifest;
    expect(manifest.head).toBe(2);
    expect(manifest.versions.map(v => v.version)).toEqual([1, 2]);
    expect(manifest.versions[1]).toMatchObject({ version: 2, parentSnapshotId: manifest.versions[0]!.snapshotId });
    expect(manifest.versions[1]).not.toHaveProperty("retired");
    expect(first.text()).toContain("Golden v1 sealed.");
  });

  it("a row unticked after the seal is retired on the next version and left on the image: nothing is uninstalled, and the lineage carries it", async () => {
    const { store, shared, next } = await sealed();
    const added = next({ tty: false, recipe: async () => ticking("tmux") });
    expect((await runInit(added.opts, added.io)).code).toBe(0);
    const before = shared.machines.length;

    const dropped = next({ tty: false });
    expect((await runInit(dropped.opts, dropped.io)).code).toBe(0);
    const out = dropped.text();
    expect(out).toContain("Builds version 3 on top of version 2: 1 row retired");
    expect(out).toContain("retire 1 tool: tmux, left on the image");
    expect(out).toContain("tmux retired: out of the recipe, left on the image");
    const ran = shared.machines.slice(before - 1).flatMap(m => m.execLog);
    expect(ran.filter(c => /uninstall|apt-get purge/.test(c))).toEqual([]);
    const manifest = (await store.get("goldens", "default")) as GoldenManifest;
    expect(manifest.head).toBe(3);
    expect(manifest.versions.find(v => v.version === 3)!.retired).toEqual([{ id: "tools/catalog/tmux", name: "tmux" }]);
  });

  it("a third version names only the row it retires, while its record carries every row the image still holds", async () => {
    const { store, shared, next } = await sealed();
    // v2 drops yq and picks up tmux.
    const two = next({ tty: false, recipe: async () => without(ticking("tmux"), "yq") });
    expect((await runInit(two.opts, two.io)).code).toBe(0);
    expect(two.text()).toContain("Builds version 2 on top of version 1: 1 tool added, 1 row retired");
    const before = shared.machines.length;

    // v3 drops tmux. yq was retired a version ago and is nothing this run did.
    const three = next({ tty: false, recipe: async () => without(RECIPE, "yq") });
    expect((await runInit(three.opts, three.io)).code).toBe(0);
    const out = three.text();
    expect(out).toContain("Builds version 3 on top of version 2: 1 row retired");
    expect(out).toContain("retire 1 tool: tmux, left on the image");
    expect(out).toMatch(/Tools, agents and machine context: 0 installed, 1 retired, /);
    expect(out).toContain("tmux retired: out of the recipe, left on the image");
    // The run never claims to have retired yq: that happened at v2.
    expect(out).not.toContain("yq retired");
    expect(out).not.toContain("retired: yq");
    expect(shared.machines.slice(before - 1).flatMap(m => m.execLog).filter(c => /uninstall|apt-get purge/.test(c))).toEqual([]);

    // The version's record is the whole truth about its image, so it carries both.
    const manifest = (await store.get("goldens", "default")) as GoldenManifest;
    expect(manifest.versions.find(v => v.version === 2)!.retired).toEqual([{ id: "tools/brew/yq", name: "yq" }]);
    expect(manifest.versions.find(v => v.version === 3)!.retired).toEqual([
      { id: "tools/brew/yq", name: "yq" },
      { id: "tools/catalog/tmux", name: "tmux" },
    ]);
  });

  it("--yes with a big change (an agent added) takes the rebuild: the boot question follows, the kept builder is no blocker, a fresh builder boots beside it, and its seal forks nothing beside the existing workspace", async () => {
    const { store, shared, first, next } = await sealed();
    // The person's one workspace, forked from v1 before the rebuild.
    const alpha = await createRuntime({ backend: shared, store, adapters: {} }).workspaces.create({ golden: "snap_golden-v1", name: "alpha" });
    // A measured build on this computer whose tools stage alone took 17m39s; the stages sum to 22 minutes.
    noteOutcomes(importResultPath(first.opts.statePath), { build: { at: "2026-09-05T19:44:00.000Z", stages: { creating: 62_000, "deploying-daemon": 35_000, "applying-setup": 4_000, "uploading-files": 6_000, "installing-harness": 48_000, "installing-tools": 1_059_000, "installing-mcp": 3_000, snapshotting: 41_000, "smoke-forking": 82_000 } } });
    const f = next({ recipe: async () => ticking("codex") });
    const hosted: string[] = [];
    f.opts.host = async (rt, builder) => {
      hosted.push(builder.id);
      return { port: 4400, wsPort: 4410, authToken: "tok", createWorkspace: name => forkHead(rt, name), ...fakeProjects([], []), close: async () => {} };
    };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("add 1 agent: Codex");
    expect(out.replace(/\s*│?\s*\n│\s+/g, " ")).toContain("A big change: a rebuild from scratch is the safer road, about 22 minutes last time.");
    expect(out).toContain("Rebuilding from scratch. Taken as the default (--yes).");
    // The kept builder holds a slot the rebuild needs; it goes after the confirm and before the boot, said once.
    expect(out).toContain("Stopping the builder kept from golden v1 (m1) to free its machine slot.");
    expect(out.indexOf("Stopping the builder kept")).toBeGreaterThan(out.indexOf("Boot a "));
    expect(out.indexOf("Stopping the builder kept")).toBeLessThan(out.indexOf("Creating the machine"));
    expect(out).toMatch(BOOT);
    expect(out).not.toContain("A builder from an earlier wsp init is still running");
    expect(out).not.toContain("Nothing was booted");
    expect(hosted).toEqual(["m4"]);
    // The rebuilt builder seals v2 and is kept; its smoke fork is gone. v1 stays for the workspace forked from it,
    // which stays where it is: no second workspace is forked, and the app opens on the one there.
    expect(out).toContain("Golden v2 sealed.");
    expect(out).toContain("Your 1 workspace stays on the golden version it was forked from; upgrade it from the app. New workspaces fork v2.");
    expect(out).not.toContain("Workspace first");
    expect(out).not.toContain("Forking your first workspace");
    expect(out).toMatch(/^◇\s+Open http:\/\/127\.0\.0\.1:4400\/$/m);
    expect((await f.runtimes.at(-1)!.workspaces.list()).map(w => [w.id, w.golden])).toEqual([[alpha.id, "snap_golden-v1"]]);
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_golden-v1", true], ["snap_golden-v1", false], [undefined, false], ["snap_golden-v2", true]]);
  });

  it("interactive: the offer is a choice with the update first when the change is small; enter takes it", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("How do you want to apply them?");
    const asked = f.text();
    expect(asked).toContain("Update the golden (under a minute, about $0.11/hr while it runs)");
    expect(asked).toContain("Rebuild from scratch (under a minute last time)");
    expect(asked.indexOf("Update the golden")).toBeLessThan(asked.indexOf("Rebuild from scratch"));
    await f.press(KEY.enter);
    expect((await run).code).toBe(0);
    expect(f.text()).toMatch(/Golden v2 sealed in \d+s on the builder kept since the save/);
    expect(f.text()).not.toMatch(BOOT);
    expect(shared.machines).toHaveLength(3);
  });

  it("the seal records how long each stage of the build ran in the import result, the closing stages apart", async () => {
    const { first } = await sealed();
    const { build } = JSON.parse(readFileSync(join(dirname(first.opts.statePath), "golden-import.json"), "utf8")) as { build: { at: string; stages: Record<string, number> } };
    expect(Date.parse(build.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(Object.keys(build.stages)).toEqual(["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp", "snapshotting", "smoke-forking"]);
    for (const ms of Object.values(build.stages)) expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("with no measured build in the import result the rebuild is offered at the assumed ten minutes and says so", async () => {
    const { shared, first, next } = await sealed();
    rmSync(importResultPath(first.opts.statePath));
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("How do you want to apply them?");
    expect(f.text()).toContain("Rebuild from scratch (about ten minutes, not measured on this computer yet)");
    await f.press(KEY.ctrlC);
    await run;
    expect(shared.machines).toHaveLength(2);
  });

  it("a head sealed before the base tools existed is offered the rebuild only: no update choice, the boot question follows", async () => {
    const { store, first, next } = await sealed();
    const manifest = (await store.get("goldens", "default")) as GoldenManifest;
    await store.put("goldens", "default", { ...manifest, versions: manifest.versions.map(({ base: _base, ...v }) => v) });
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    const asked = f.text();
    expect(asked).toContain("Changes since golden v1");
    expect(asked).toContain("update 1 file: ~/.zshrc");
    expect(asked).toContain("Golden v1 was sealed before the base tools existed and cannot take an update; the rebuild is the only road, under a minute last time.");
    expect(asked).not.toContain("How do you want to apply them?");
    expect(asked).not.toContain("Update the golden");
    expect(asked).not.toContain("Small change");
    await f.press(KEY.ctrlC);
    expect((await run).code).toBe(1);
    expect(f.text()).toContain("Nothing was booted. The recipe is kept.");
  });

  it("a kept builder another process holds does not count as the update's machine: the offer names the fork road and its two minutes", async () => {
    const { store, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: process.ppid } });
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Small change: update on a fork of the golden, about two minutes");
    expect(out).toMatch(/Golden v2 sealed in \d+s from a fork of the golden/);
  });

  it("interactive: down then enter picks the rebuild, and the boot question follows", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("How do you want to apply them?");
    await f.press(KEY.down, KEY.enter);
    await f.until(BOOT);
    await f.press(KEY.esc);
    expect((await run).code).toBe(1);
    expect(f.text()).toContain("Nothing was booted. The recipe is kept.");
    // No costs nothing: the kept builder is as it was.
    expect(f.text()).not.toContain("Stopping the builder kept");
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a kept builder that is no longer first-life is not the update's machine", async () => {
    const { store, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const record = (await store.get("builders", "m1")) as { firstLife: boolean };
    await store.put("builders", "m1", { ...record, firstLife: false });
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("Small change: update on a fork of the golden, about two minutes");
  });
});

describe("wsp init --recipe", () => {
  const recipeFile = (f: Fake): string => {
    const path = join(dirname(f.opts.statePath), "recipe.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [
        { id: "claude", kind: "agent", on: false, source: { kind: "popular", sessions: 149, images: 1 } },
        { id: "codex", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.codex/config.toml"], bin: true } },
        { id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 }, signIn: "copy" },
        { id: "yq", kind: "tool", on: false, source: { kind: "popular", sessions: 0, images: 3 } },
        { id: "agent-browser", kind: "tool", on: true, source: { kind: "used", sessions: 45, calls: 2591 } },
      ],
    }));
    return path;
  };

  it("skips the pick screens and lands on the sign-ins, the recipe's ticks and answers in place, then saves them", async () => {
    const f = fake();
    f.opts.recipeFile = recipeFile(f);
    const run = runInit(f.opts, f.io);
    await f.until("Sign-ins");
    const out = f.text();
    // The machine was still read; the card says what ticked it and counts the collector's rows, not the catalog's bare one.
    expect(out).toContain("15 found on this computer, ticked by the recipe.");
    expect(out).not.toContain("not in this build");
    // No Agents or Tools screen: the run opens on the sign-ins.
    expect(out).not.toContain("1/6");
    expect(out).toMatch(/Sign-ins\s+4\/6/);
    // Codex is on and Claude Code off, so only Codex's login is listed, to sign in on the machine; the saved copy answer for gh is a ticked keys row.
    expect(out).toMatch(/Codex login\s+[^\n]*sign in on the machine/);
    expect(out).not.toContain("Claude Code login");
    expect(out).toMatch(/GitHub CLI login\s+[^\n]*copy from this Mac/);
    await f.press(KEY.enter);
    await f.until("wsp for your agents on this Mac  5/6");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/codex")).toMatchObject({ bring: true });
    expect(saved.get("agents/claude")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/gh")).toMatchObject({ bring: true });
    expect(saved.get("tools/brew/yq")).toMatchObject({ bring: false });
    expect(saved.get("tools/npm/tsx")).toMatchObject({ bring: false });
    // The ticked tool this Mac has no row for is saved as the catalog's bare row, so the build installs it by its road.
    expect(saved.get("tools/catalog/agent-browser")).toMatchObject({ label: "agent-browser", bring: true });
    expect(saved.get("logins/gh")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("logins/codex")).toMatchObject({ bring: false, choice: "machine" });
    // The other rungs took their defaults, as the screens would have.
    expect(saved.get("identity/git-user")).toMatchObject({ bring: true });
  });

  it("with --yes the recipe's saved copy answer is honoured like a saved manifest's: the Keychain is read, the golden built", async () => {
    const f = fake({ yes: true });
    f.opts.recipeFile = recipeFile(f);
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/codex")).toMatchObject({ bring: true });
    expect(saved.get("agents/claude")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/yq")).toMatchObject({ bring: false });
    expect(saved.get("logins/gh")).toMatchObject({ bring: true, choice: "copy" });
    expect(f.text()).toContain("GitHub CLI login: copied");
    // agent-browser has no row here: the build installed it by its catalog road, an npm global, and the tally says the road is unmeasured.
    expect(f.backends[0]!.machines[0]!.execLog.some(c => c.includes("npm install -g agent-browser@0.31.1"))).toBe(true);
    const tools = JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).tools as { id: string; outcome: string; note?: string }[];
    expect(tools.find(t => t.id === "tools/catalog/agent-browser")).toMatchObject({ outcome: "installed", note: "by an unmeasured road" });
    expect(f.text()).toMatch(/Installing tools\s+\d+ installed \(agent-browser by an un/);
  });

  it("a row the catalog does not carry installs after the catalog's own, is recorded by name, and is offered no sign-in", async () => {
    const f = fake({ yes: true });
    const path = join(dirname(f.opts.statePath), "recipe.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [{ id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 } }],
      custom: [{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "used in wsp" }],
    }));
    f.opts.recipeFile = path;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log.some(c => c.includes("brew install just"))).toBe(true);
    // After every catalog road: the gh formula went first.
    expect(log.findIndex(c => c.includes("brew install just"))).toBeGreaterThan(log.findIndex(c => c.includes("brew install gh")));
    const tools = JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).tools as { id: string; label: string; outcome: string }[];
    expect(tools.at(-1)).toMatchObject({ id: "tools/custom/just", label: "just", outcome: "installed" });
    // The row travels in the small recipe, so a second run carries it; no sign-in was ever offered for it.
    expect(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")).custom).toEqual([{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "used in wsp" }]);
    expect(f.text()).not.toContain("just login");
  });

  it("names the recipe file, not screens it never drew, when the recipe it was given overfills the disk", async () => {
    const f = fake({ yes: true });
    const path = join(dirname(f.opts.statePath), "given.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [],
      custom: [{ kind: "custom", id: "brew/llvm", name: "llvm", install: ["brew install llvm"], check: "brew list llvm", manager: "brew", size: 30 * 1024 * 1024 * 1024, why: "installed on this Mac by brew" }],
    }));
    f.opts.recipeFile = path;
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain(`Untick about 14.8 GB of tools or agents in ${path}`);
    expect(out).not.toContain("What they need");
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
  });

  it("the wsp tools rows follow the agents on this Mac, not the recipe's recorded source; a ticked row writes here, and a file with comments says they are gone", async () => {
    const f = fake();
    // The file says Codex is installed where it was written; this Mac has Claude Code and Gemini CLI.
    f.opts.recipeFile = recipeFile(f);
    f.opts.recipe = async () => ({ ...RECIPE, rows: [...RECIPE.rows, { id: "gemini", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.gemini/settings.json"], bin: true } }] });
    mkdirSync(join(f.opts.home, ".gemini"), { recursive: true });
    writeFileSync(join(f.opts.home, ".gemini", "settings.json"), '{\n  // the theme\n  "theme": "dark"\n}\n');
    const run = runInit(f.opts, f.io);
    // A recipe file decides the agents and the tools, so the run opens on the sign-ins and the wsp tools follow.
    await f.until("Sign-ins  4/6");
    await f.press(KEY.enter);
    await f.until("wsp for your agents on this Mac  5/6");
    const screen = f.text().slice(f.text().lastIndexOf("◆  wsp for your agents on this Mac"));
    expect(screen).toMatch(/○ Claude Code\n┃\s+○ Gemini CLI\n/);
    expect(screen).not.toContain("Codex");
    await f.press(..."gemini");
    await f.until(/search {2}gemini/);
    await f.press(KEY.space);
    await f.until(/● Gemini CLI/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    const out = f.text();
    expect(out).toMatch(/Gemini CLI now has the wsp tools: ~\/\.gemini\/settings\.json\n│\s+The file held comments; the rewrite is plain JSON, so they are gone\.\n/);
    expect(out).not.toContain("Claude Code now has the wsp tools");
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    const settings = JSON.parse(readFileSync(join(f.opts.home, ".gemini", "settings.json"), "utf8")) as { theme: string; mcpServers: { wsp: { args: string[] } } };
    expect(settings.theme).toBe("dark");
    expect(settings.mcpServers.wsp.args.slice(-3)).toEqual(["mcp", "--state", f.opts.statePath]);
    await f.press("n");
    expect((await run).code).toBe(1);
    // The saved recipe is this Mac's rows with the file's ticks on them: what is here as each row's source, a row the file lacked off.
    const saved = Recipe.parse(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "recipe.json"), "utf8")));
    expect(saved.rows.find(r => r.id === "codex")).toMatchObject({ on: true, source: { kind: "popular" } });
    expect(saved.rows.find(r => r.id === "claude")).toMatchObject({ on: false, source: { kind: "installed" } });
    expect(saved.rows.find(r => r.id === "gemini")).toMatchObject({ on: false, source: { kind: "installed" } });
  });

  it("a recipe that does not parse ends the run before anything is read or booted", async () => {
    const f = fake({ collect: async () => { throw new Error("collect must not run on a bad recipe"); } });
    f.opts.recipeFile = join(dirname(f.opts.statePath), "recipe.json");
    writeFileSync(f.opts.recipeFile, JSON.stringify({ version: 2 }));
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.text()).toMatch(/recipe\.json: invalid recipe: version/);
    expect(f.backends).toHaveLength(0);
  });
});

describe("wsp init, the first workspace and its project", () => {
  it("--first-workspace and --import fork, then import, then open the app on that workspace, with the consent the app's import starts from", async () => {
    const f = fake({ tty: false });
    const folder = mkdtempSync(join(tmpdir(), "wsp-init-proj-"));
    dirs.push(folder);
    f.opts.firstWorkspace = "proj";
    f.opts.importFolder = folder;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["proj"]);
    // The fork, then the import onto it. Off a terminal nothing is launched, so the address is printed below.
    expect(f.trail).toEqual(["fork proj", `import ${folder} -> ${folder}`]);
    // The app's own defaults, unchanged: the rewrite travels, the bare secret is cut, the agent with sessions comes.
    expect(f.imports).toEqual([{ workspaceId: workspaces[0]!.id, source: folder, dest: folder, carry: [], rewrite: [".git/config"], agents: ["claude"] }]);
    const out = f.text();
    expect(out).toMatch(/Workspace proj \(ws_[0-9a-f]+\) forked from golden v1\./);
    expect(out).toContain("12 files, 3.0 KB; the repository whole; 46 sessions from Claude Code; 2 secret-shaped files read for what may travel.");
    expect(out).toContain(`${folder} on proj: 12 files, 3.0 KB; 1 file rewritten without their credentials; 1 secret-shaped file cut.`);
    expect(out).toMatch(new RegExp(`^◇\\s+Open http://127\\.0\\.0\\.1:4400/#w/${workspaces[0]!.id}$`, "m"));
    expect(out).not.toContain("Done. wsp up starts the app");
  });

  it("No at the last question forks nothing, imports nothing, and leaves the plain address", async () => {
    const f = fake({ tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await f.until("Make your first workspace and import a project now?");
    await f.press("n");
    expect((await run).code).toBe(0);
    expect(f.trail).toEqual(["open http://127.0.0.1:4400/"]);
    expect(f.imports).toEqual([]);
    expect(await f.runtimes.at(-1)!.workspaces.list()).toEqual([]);
    const out = f.text();
    expect(out).toContain("Done. wsp up starts the app; opening it now.");
    expect(out).not.toContain("Forking your first workspace");
  });

  it("Yes with a typed folder forks under the default name and imports what was typed", async () => {
    const f = fake({ tty: true });
    const folder = mkdtempSync(join(tmpdir(), "wsp-init-proj-"));
    dirs.push(folder);
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await f.until("Make your first workspace and import a project now?");
    await f.press(KEY.enter);
    await f.until("Which folder on this Mac?");
    await f.press(folder, KEY.enter);
    expect((await run).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["first"]);
    expect(f.trail).toEqual(["fork first", `import ${folder} -> ${folder}`, `open http://127.0.0.1:4400/#w/${workspaces[0]!.id}`]);
  });

  it("Yes with nothing typed forks the workspace and imports no project", async () => {
    const f = fake({ tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await f.until("Make your first workspace and import a project now?");
    await f.press(KEY.enter);
    await f.until("Which folder on this Mac?");
    await f.press(KEY.enter);
    expect((await run).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(f.trail).toEqual(["fork first", `open http://127.0.0.1:4400/#w/${workspaces[0]!.id}`]);
    expect(f.imports).toEqual([]);
  });

  it("a --import folder that is not there ends the run before anything is read or booted", async () => {
    const f = fake({ tty: false, collect: async () => { throw new Error("collect must not run on a bad --import"); } });
    f.opts.importFolder = join(tmpdir(), "wsp-init-no-such-folder");
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.text()).toContain(`--import ${f.opts.importFolder}: no folder there on this computer`);
    expect(f.backends).toHaveLength(0);
    expect(f.trail).toEqual([]);
  });

  it("a --import path that is a file, not a folder, ends the run the same way", async () => {
    const f = fake({ tty: false, collect: async () => { throw new Error("collect must not run on a bad --import"); } });
    const file = join(f.opts.home, ".zshrc");
    f.opts.importFolder = file;
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.text()).toContain(`--import ${file}: not a folder`);
    expect(f.backends).toHaveLength(0);
  });

  it("esc at the folder prompt forks the workspace with no project, the same as enter on nothing", async () => {
    const f = fake({ tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await f.until(FIRST_QUESTION);
    await f.press(KEY.enter);
    await f.until(FOLDER_QUESTION);
    await f.press(KEY.esc);
    expect((await run).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["first"]);
    expect(f.trail).toEqual(["fork first", `open http://127.0.0.1:4400/#w/${workspaces[0]!.id}`]);
    expect(f.imports).toEqual([]);
    expect(f.text()).not.toContain("Done. wsp up starts the app");
  });

  it("an import that fails keeps the workspace and says where to import it from", async () => {
    const f = fake({ tty: false });
    const folder = mkdtempSync(join(tmpdir(), "wsp-init-proj-"));
    dirs.push(folder);
    f.opts.importFolder = folder;
    const host = f.opts.host;
    f.opts.host = async (rt, builder, hooks) => ({ ...(await host(rt, builder, hooks)), importProject: async () => { throw new Error("the machine refused the upload"); } });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["first"]);
    expect(f.text()).toContain(`${folder} was not imported: the machine refused the upload. The workspace is up; import it from the app.`);
    // The workspace survived the failed import, so the app still opens on it.
    expect(f.text()).toMatch(new RegExp(`Open http://127\\.0\\.0\\.1:4400/#w/${workspaces[0]!.id}`));
  });
});
