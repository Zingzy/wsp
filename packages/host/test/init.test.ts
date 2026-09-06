// SPDX-License-Identifier: AGPL-3.0-only
// wsp init end to end against the stub backend: keys in, the seven screens,
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
import { APP_DATA_GROUP, RUNGS, claimedPaths, entriesFor, everything, nodeMachineFs, type Machine, type Manifest, type ManifestEntry } from "@wsp/collect";
import { SNAPSHOT_STORAGE, type BackendPricing, type BrewFormula, type BrewTable } from "@wsp/engine";
import { ALREADY_APPLIED } from "@wsp/protocol";
import { DAEMON_TOKEN_SET, createRuntime, memoryStore, type GoldenRecipe, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GOLDEN_SETUP } from "@wsp/catalog";
import { loadManifest, recipePath } from "../src/init-recipe.js";
import { CARD_FRAME, card, widthOf } from "../src/init-layout.js";
import { editorsIntro, everythingItems, fmtBytes, reduceStages, runInit, selectItem, shellItems, stageLine, summaryNote, toolsItems, type HostHooks, type InitIO, type InitOptions } from "../src/init.js";
import type { HostHandle } from "../src/server.js";
import { startCallbackRelay } from "../src/relay.js";
import type { ConnectOptions, DaemonSocket } from "../src/doctor.js";
import { SH_FILE, appendCommand, readCommand } from "../src/init-secrets.js";
import { noteOutcomes } from "../src/init-signin.js";
import { checkScript } from "../src/signin-relay.js";
import { answersChecks, checkTag, fakePtyLink, type CheckAnswer, type FakePty, type FakePtyLink } from "./fake-pty-link.js";
import { EVERYTHING, FIXTURE } from "./init-fixture.js";
import { guestAnswer, stubBackend, type StubBackend, type StubMachine } from "./stub-backend.js";

const SOLARI = "slr_live_fake_solari_key";
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", space: " ", enter: "\r", esc: "\x1b", ctrlC: "\x03" };
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\//;
const SEAL_Q = (v: number) => `Seal this machine as golden v${v}?`;
const BOOT = /Boot a \d+ vCPU/;
const PRICING: BackendPricing = { rateUsdPerHour: s => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE };

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
}

const DEVICE_URL = "https://github.com/login/device";
const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

/** The check script typed on this pty of the fake builder for these status commands, as its writes read joined. */
const typed = (pty: FakePty, ...commands: string[]): string => checkScript(commands, SH_FILE, checkTag(pty)).map(l => `${l}\r`).join("");

/** Ptys on the fake builder: a login prints its page's URL and exits (or waits for Ctrl-C when held); the check script
 * is answered per status command, by `answer` first and as told otherwise. */
function scriptedLink(state: { signedIn: boolean; hold: boolean; missing: boolean }, answer?: (command: string) => CheckAnswer | undefined): FakePtyLink {
  const link = fakePtyLink();
  const checks = answersChecks(link, command => {
    const own = answer?.(command);
    if (own !== undefined) return own;
    if (command.includes("kubectl config current-context")) return { output: "minikube", exitCode: 0 };
    return state.signedIn ? { output: 'Logged in using ChatGPT\nLogged in to github.com account someone (keyring)\n{"loggedIn": true}', exitCode: 0 } : { output: "Not logged in", exitCode: 1 };
  });
  link.script = (pty, line) => {
    if (checks(pty, line)) return;
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

function fake(over: Partial<InitOptions> & { tty?: boolean; env?: Record<string, string>; columns?: number; signedIn?: boolean; hold?: boolean; missing?: boolean } = {}): Fake {
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
  const backends: StubBackend[] = [];
  const recipes: GoldenRecipe[] = [];
  const runtimes: Runtime[] = [];
  const hooks: HostHooks[] = [];
  const link = scriptedLink({ signedIn: over.signedIn ?? true, hold: over.hold ?? false, missing: over.missing ?? false });
  const counters = { hosts: 0, closed: 0 };
  const signals = new EventEmitter();
  const exits: number[] = [];
  const io: InitIO = {
    input,
    output,
    stderr,
    isTTY: over.tty ?? true,
    env: over.env ?? {},
    open: async url => {
      opened.push(url);
      return true;
    },
    signals,
    exit: code => {
      exits.push(code);
    },
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
  const { tty: _tty, env: _env, columns: _columns, signedIn: _signedIn, hold: _hold, missing: _missing, ...rest } = over;
  const opts: InitOptions = {
    yes: false,
    collect: async () => FIXTURE,
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
      const handle: HostHandle = { port: 4400, wsPort: 4410, authToken: "tok", createWorkspace: name => forkHead(rt, name), close: async () => void (counters.closed += 1) };
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
  };
}

/** What the host's own create does: a fork of the golden's head under the given name. */
async function forkHead(rt: Runtime, name: string) {
  const manifest = await rt.golden.get();
  const head = manifest?.versions.find(v => v.version === manifest.head);
  if (!head) throw new Error("no golden image yet");
  return rt.workspaces.create({ golden: head.snapshotId, name });
}

/** Enter at the seal question: the default answer is yes. */
async function sealIt(f: Fake, version = 1): Promise<void> {
  await f.until(SEAL_Q(version));
  await f.press(KEY.enter);
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
const quietHost = () => async (): Promise<HostHandle> => ({ port: 4400, wsPort: 4410, authToken: "tok", createWorkspace: async () => { throw new Error("no workspace in this fixture"); }, close: async () => {} });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A saved recipe with the gh login answered copy: under --yes a saved answer is kept, where the default would sign in on the machine. */
function withGhCopy(f: Fake): void {
  const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
  dirs.push(dir);
  f.opts.manifestPath = join(dir, "recipe.json");
  writeFileSync(f.opts.manifestPath, JSON.stringify({ entries: FIXTURE.entries.map(e => (e.id === "logins/gh" ? { ...e, bring: true, choice: "copy" } : e)) }));
}

describe("wsp init, interactive", () => {
  it("the Editors screen says what the rung is for and what each row does on the machine", async () => {
    const f = fake({ columns: 140 });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Shell");
    await f.press(KEY.enter);
    await f.until("Editors");
    const screen = f.text().slice(f.text().lastIndexOf("◆  Editors"));
    // The two lines sit right under the title, wrapped to the terminal, before the search.
    const head = screen.split("\n").slice(1, screen.split("\n").findIndex(l => l.startsWith("┃  search")));
    // The fixture holds neovim with its config and no VS Code or Cursor row, so the intro is the one line about it.
    expect(head.map(l => l.replace(/^┃\s+/, ""))).toEqual(["neovim is installed on the machine with your config; it runs in the workspace's terminal."]);
    expect(editorsIntro(FIXTURE.entries.filter(e => e.rung === "editors"))).toEqual(head.map(l => l.replace(/^┃\s+/, "")));
    // Down from the all row onto neovim: its detail names the install and the config copy.
    await f.press(KEY.down);
    await f.until(/neovim, installed with your config\n/);
    expect(f.text().slice(f.text().lastIndexOf("◆  Editors"))).toContain("~/.config/nvim\n┃  117.2 KB, installed on the machine by apt; your config comes along");
    await f.press(KEY.enter);
    for (const rung of ["Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until(BOOT);
    expect(f.text().slice(f.text().lastIndexOf("Summary"))).toMatch(/Installs\s+Claude Code, neovim, 3 tools plus Homebrew's toolchain/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
  });

  it("detects first, walks the seven rungs, confirms once, prepares through the runtime, signs in, seals on enter, forks the first workspace and opens the app", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);

    await f.until("Identity");
    const first = f.text();
    // Screen one is the detection result, before any question.
    expect(first).toContain("Found on this computer");
    expect(first).toMatch(/Tools\s+4\s+3 can come/);
    expect(first).toContain("Nothing has left this computer.");
    expect(first.indexOf("Found on this computer")).toBeLessThan(first.indexOf("1/8"));
    // The all row counts what the table counted: the required row comes along, the private key cannot.
    expect(first).toMatch(/Identity\s+3\s+[\d.]+ KB\s+2 can come/);
    expect(first).toMatch(/all\s+2 of 2\n/);
    // The detection result is a card down the bar, not a closed box: no corners, no rule, every line under the title starts with the thin bar.
    const found = first.slice(first.indexOf("Found on this computer"), first.indexOf("1/8"));
    expect(found).not.toMatch(/[╮╯─├]/);
    expect(found.split("\n").slice(1, -1).filter(l => l !== "").every(l => l.startsWith("│"))).toBe(true);
    expect(found).toMatch(/^Found on this computer\n│  Identity\s+\d+/);
    expect(first).toContain("1/8");
    expect(first).not.toMatch(/claude|codex/i);
    await f.press(KEY.enter);
    await f.until("Shell");
    expect(f.text()).toContain("2/8");
    await f.press(KEY.enter);
    await f.until("Editors");
    await f.press(KEY.enter);
    await f.until("Toolchains");
    await f.press(KEY.enter);
    await f.until("Tools");
    await f.press(KEY.enter);
    await f.until("Agents");
    expect(f.text()).toContain("Claude Code");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    // Both logins have a browser or device flow, so both start as a sign-in on the machine; nothing is copied unless the person opts in.
    expect(f.text()).toMatch(/GitHub CLI login\s+sign in/);
    expect(f.text()).toMatch(/Claude Code login\s+sign in/);
    expect(f.text()).toMatch(/Sign-ins\s+7\/8\s+2 sign in/);
    // Codex was left unticked on the Agents screen, so its login is not offered.
    expect(f.text()).not.toContain("Codex login");
    await f.press(KEY.enter);

    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"), f.text().lastIndexOf("Recipe saved"));
    // One line per rung, the sign-ins under theirs with the answer each got, then the three closing lines.
    // A closing line wrapped under its column continues on indented lines, which are not rows.
    const body = summary.split("\n").map(l => l.replace(/^│\s{2}|\s*│$/g, "").trimEnd()).filter(l => l !== "" && !/^[─├╯╮◇ ]*$/.test(l) && !l.startsWith("Summary") && !/^\s{4}/.test(l));
    expect(body.map(l => l.trim().split(/\s{2,}/)[0])).toEqual([
      "Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins", "GitHub CLI login", "Claude Code login", "Upload", "Installs", "Disk",
    ]);
    expect(summary).not.toMatch(/[╮╯─├]/);
    expect(summary).toMatch(/Identity\s+2 of 3\s+1\.7 KB/);
    expect(summary).toMatch(/Tools\s+3 of 4\n/);
    // Both logins sign in on the machine: chosen, as the rung header counted them, not "0 of 2".
    expect(summary).toMatch(/Sign-ins\s+2 sign in\n/);
    expect(summary).toMatch(/GitHub CLI login\s+sign in/);
    expect(summary).toMatch(/Claude Code login\s+sign in/);
    expect(summary).not.toContain("id_ed25519");
    expect(summary).toMatch(/Upload\s+\d[\d.]* [KM]B, nothing has left this computer yet/);
    // Their three ticked tools; Homebrew's own glibc and gcc are named apart, not counted as theirs.
    expect(summary).toMatch(/Installs\s+Claude Code, neovim, 3 tools plus Homebrew's toolchain/);
    // Without a Homebrew table the two formulae have no size and count at 100 MB each, pnpm at 50; the toolchain and Claude Code are measured.
    expect(summary.replace(/\n\s*│?\s+/g, " ")).toMatch(/Disk\s+1\.4 GB of 15\.2 GB on the 20 GB builder \(files [\d.]+ KB, Homebrew's toolchain 1\.0 GB, agents 208\.0 MB; 3 unmeasured, ~250\.0 MB\)/);
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
    await f.press("y");

    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.handle?.port).toBe(4400);

    const out = f.text();
    const order = ["Machine created", "Base installed", "Setup applied", "Files uploaded", "Agents installed", "Tools installed", "MCP servers installed", "Ready"].map(s => out.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("node v22.12.0");
    expect(out).toContain("3 files: identity 2, shell 1");
    expect(out).toContain("Claude Code installed");
    expect(out).toContain("golden-import.json");
    // A finished stage: label, detail, and its duration flush against the right edge, one cell inside the
    // 80 columns of a terminal that says nothing, so no stage line can ever reach the wrap.
    const base = out.split("\n").filter(l => /Base installed/.test(l)).at(-1)!;
    expect(base).toMatch(/Base installed\s+node v22\.12\.0\s+\d+\.\ds$/);
    expect(base.length).toBe(79);
    // The sign-ins chosen for the machine ran here, each proved by the tool's status command, before the seal.
    const signing = out.indexOf("Signing in on the machine");
    expect(signing).toBeGreaterThan(out.indexOf("Ready"));
    expect(out).toMatch(/GitHub CLI login\s+gh auth login/);
    expect(out).toMatch(/GitHub CLI login: signed in \(gh auth login exited 0\)/);
    expect(out).toMatch(/Claude Code login\s+claude auth login/);
    expect(out).toMatch(/Claude Code login: signed in \(claude auth login exited 0\)/);
    expect(out).toContain("Press Enter to open https://github.com/login/device");
    expect(out.slice(signing)).toContain("o opens it on this computer");
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["exec gh auth login || exit\r", "exec claude auth login || exit\r"]);
    expect(f.link.ptys.every(p => p.killed)).toBe(true);
    expect(f.hooks[0]!.autoOpen(f.backends[0]!.machines[0]!.id, DEVICE_URL)).toBe(false);
    // After the sign-ins the seal summary: what landed, one section each, then the question with enter as yes.
    const ready = out.indexOf("Ready to seal golden v1");
    expect(ready).toBeGreaterThan(signing);
    const summaryCard = out.slice(ready, out.indexOf(SEAL_Q(1)));
    // Homebrew, its two toolchain formulae, the shared step, gh, jq, pnpm and neovim.
    expect(summaryCard).toMatch(/Tools\n│\s+8 installed\n/);
    expect(summaryCard).toMatch(/Agents\n│\s+1 installed: Claude Code\n/);
    expect(summaryCard).toMatch(/Sign-ins\n│\s+GitHub CLI login\s+signed in\n│\s+Claude Code login\s+signed in\n/);
    expect(summaryCard).toMatch(/Secrets\n│\s+none\n/);
    expect(summaryCard).not.toMatch(/[╮╯─├]/);
    // The seal streams in the same frame, then the fork, then the app opens once, into it.
    const sealing = out.indexOf(SEAL_Q(1));
    for (const step of ["Snapshot taken", "Fork booted and checked", "Sealed"]) expect(out.indexOf(step)).toBeGreaterThan(sealing);
    expect(out.indexOf("Snapshot taken")).toBeLessThan(out.indexOf("Fork booted and checked"));
    expect(out).toContain("Golden v1 sealed.");
    expect(out).toMatch(/Workspace first \(ws_[0-9a-f]+\) forked from golden v1\./);
    const opened = out.indexOf("Opened http://");
    expect(opened).toBeGreaterThan(out.indexOf("forked from golden v1"));
    expect(out.slice(opened).split("\n")[0]!.replace(/^│\s+/, "")).toMatch(/^Opened http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(out).toContain("wsp keeps serving the app from this terminal; Ctrl-C stops it.");
    expect(out).not.toMatch(/checklist|Save the golden there/);
    expect(out).not.toMatch(/—|\p{Emoji_Presentation}/u);
    expect(out).not.toContain(SOLARI);
    // gh was switched to sign in on the machine, so its Keychain token was never asked for.
    expect(f.reads).toEqual([]);

    const backend = f.backends[0]!;
    // The builder, the seal's smoke fork, the first workspace.
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_golden-v1", true], ["snap_golden-v1", false]]);
    const log = backend.machines[0]!.execLog;
    expect(log.some(c => c.includes("tar xzf") && c.includes("--no-same-owner"))).toBe(true);
    expect(log.filter(c => c.includes("brew install") || c.includes("npm install -g pnpm"))).toHaveLength(6);
    expect(log.map(c => /brew install ([a-z@.-]+)/.exec(c)?.[1]).filter(Boolean)).toEqual(["glibc", "gcc", "gh", "jq"]);
    // gh and jq share dependencies: one brew process installs those before either formula.
    expect(log.filter(c => c.includes("brew deps --for-each"))).toHaveLength(1);
    expect(log.findIndex(c => c.includes("brew deps --for-each"))).toBeLessThan(log.findIndex(c => c.includes("brew install gh")));
    expect(log.some(c => c.includes(GOLDEN_SETUP))).toBe(true);
    expect(log.indexOf(log.find(c => c.includes("tar xzf"))!)).toBeLessThan(log.indexOf(log.find(c => c.includes("brew install"))!));
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      files: { bytes: expect.any(Number) },
      homebrew: { tag: expect.stringMatching(/^6\./), commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
      tools: [{ id: "editors/nvim", outcome: "installed" }, { id: "tools/homebrew", outcome: "installed" }, { id: "tools/brew-toolchain/glibc", outcome: "installed" }, { id: "tools/brew-toolchain/gcc", outcome: "installed" }, { id: "tools/brew-shared", outcome: "installed" }, { id: "tools/brew/gh", outcome: "installed" }, { id: "tools/brew/jq", outcome: "installed" }, { id: "tools/npm/pnpm", outcome: "installed" }],
      agents: [{ id: "agents/claude", outcome: "installed" }],
      logins: [
        { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", command: "gh auth login", note: "gh auth login exited 0" },
        { id: "logins/claude", label: "Claude Code login", state: "signed-in", command: "claude auth login", note: "claude auth login exited 0" },
      ],
    });
    expect(backend.machines[0]!.spec.labels).toMatchObject({ "wsp-builder": "1" });
    expect(f.recipes[0]!.envs).toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(f.hosts).toBe(1);
    expect(f.opened).toEqual([expect.stringMatching(URL_RE)]);

    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    const bring = saved.entries.filter(e => e.bring).map(e => e.id);
    expect(bring).toEqual([
      "identity/git-user", "identity/ssh-config", "shell/zshrc", "shell/starship", "editors/nvim", "toolchains/mise",
      "tools/brew/gh", "tools/brew/jq", "tools/npm/pnpm", "agents/claude",
    ]);
    expect(saved.entries.filter(e => e.rung === "logins").map(e => e.choice)).toEqual(["machine", "machine", undefined]);
    expect(out).toContain("golden-recipe.json");
    // One link per command pair; nothing was cut, so the secrets step dialled nothing.
    expect(f.link.dials).toBe(2);
    expect(result.logins?.map(l => l.state)).toEqual(["signed-in", "signed-in"]);
    expect(result.secrets).toEqual([]);

    // The seal stamped the logins onto the version, and the first workspace is a fork of it.
    const rt = f.runtimes.at(-1)!;
    expect((await rt.golden.get())?.versions[0]?.logins).toEqual([
      { name: "GitHub CLI login", state: "signed-in" },
      { name: "Claude Code login", state: "signed-in" },
    ]);
    expect((await rt.workspaces.list()).map(w => [w.name, w.golden])).toEqual([["first", "snap_golden-v1"]]);

    // The run log beside the state holds every frame and every exec of the run, the seal's included, and the address.
    const logPath = join(dirs[0]!, "init.log");
    expect(out).toContain(`The run log is ${logPath}`);
    const runLog = readFileSync(logPath, "utf8").split("\n");
    const stamped = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;
    const heads = runLog.filter(l => stamped.test(l)).map(l => l.replace(stamped, ""));
    expect(heads[0]).toMatch(/^run [0-9a-f]{6} wsp init \(pid \d+\)$/);
    expect(heads.filter(h => h.startsWith("exec m1 "))).toHaveLength(backend.machines[0]!.execLog.length);
    expect(heads.filter(h => h.startsWith("exec m2 "))).toHaveLength(backend.machines[1]!.execLog.length);
    expect(heads).toEqual(expect.arrayContaining(["stage creating: sandbox from base", "stage ready", "note app http://127.0.0.1:4400/", expect.stringMatching(/^stage sealed: v1/)]));
    expect(heads.filter(h => h.startsWith("stage installing-tools: ")).length).toBeGreaterThan(6);
    // The free-disk reads are execs like any other, command and answer.
    expect(runLog).toContain("  $ df -Pk /root | awk 'NR==2{print $4}'");
    expect(runLog.filter(l => l.startsWith("  $ ")).length).toBeGreaterThan(heads.filter(h => h.startsWith("exec ")).length);
    expect(readFileSync(logPath, "utf8")).not.toContain(SOLARI);
  });

  it("escape on a later rung replays the earlier answer", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    // The cursor starts on the all row and skips the git bullet: one down is ssh config, untick it.
    await f.press(KEY.down, KEY.space, KEY.enter);
    await f.until("Shell");
    f.clear();
    await f.press(KEY.esc);
    await f.until("1/8");
    f.clear();
    await f.press(KEY.enter);
    await f.until("2/8");
    for (const rung of ["Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until(BOOT);
    expect(f.text().slice(f.text().lastIndexOf("Summary"))).toMatch(/Identity\s+1 of 3/);
    await f.press("y");
    await sealIt(f);
    expect((await run).code).toBe(0);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "identity/ssh-config")?.bring).toBe(false);
    expect(saved.entries.find(e => e.id === "identity/git-user")?.bring).toBe(true);
  });

  it("enter at the confirm takes No: the marker sits on No, nothing boots, and the recipe is kept for --manifest", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until(BOOT);
    const ask = f.text().slice(f.text().lastIndexOf("Boot a"));
    expect(ask).toMatch(/2 vCPU, 4 GB\s+builder/);
    expect(ask).toMatch(/\$0\.11\/hr/);
    expect(ask).toMatch(/No\s+costs\s+nothing/);
    // The confirm is the screen being answered: thick bar, the marker on No, the help line on the heavy end.
    expect(ask).toContain(`\n┃  ${S_RADIO_INACTIVE} Yes / ${S_RADIO_ACTIVE} No\n┗  ← → change • y n answer • enter choose • esc cancel`);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    expect(f.text().slice(f.text().lastIndexOf("◇  Boot a"))).toMatch(/^◇  Boot a[^\n]*\n(│    [^\n]*\n)?│  No costs nothing[^\n]*\n│  No\n└  Nothing was booted\. The recipe is kept\./);
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
    expect(f.hosts).toBe(0);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.filter(e => e.bring).map(e => e.id)).toContain("shell/zshrc");
  });

  it("an agent ticked then unticked on the Agents screen shows and then hides its login row", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Agents");
    // all row, Claude Code, Codex: tick codex.
    await f.press(KEY.down, KEY.down, KEY.space, KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).toContain("Codex login");
    expect(f.text()).toMatch(/Sign-ins\s+7\/8\s+3 sign in/);
    expect(f.text()).toMatch(/Agent logins\s+2\n/);
    await f.press(KEY.esc);
    await f.until("6/8");
    f.clear();
    await f.press(KEY.down, KEY.down, KEY.space, KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).not.toContain("Codex login");
    expect(f.text()).toMatch(/Sign-ins\s+7\/8\s+2 sign in/);
    expect(f.text()).toMatch(/Agent logins\s+1\n/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"));
    expect(summary).not.toContain("Codex login");
    expect(summary).toMatch(/Sign-ins\s+2 sign in\n/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "logins/codex")).toMatchObject({ bring: false });
    expect(saved.entries.find(e => e.id === "logins/codex")?.choice).toBeUndefined();
  });

  it("MCP servers sit under their agent on the Agents screen, say what each carries, and the summary counts them", async () => {
    const github: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", detail: "stdio: npx @modelcontextprotocol/server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)" };
    const notes: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "skip", reason: "command ~/Library/Notes/mcp is macOS-only, will not run", detail: "stdio: ~/Library/Notes/mcp; carries no secret" };
    const scope = { rung: "agents" as const, group: "Claude Code MCP servers", hint: "user scope and your home folder", note: "12 more in 2 project folders stay on this computer (a repo's .mcp.json travels with it)" };
    const f = fake({ collect: async () => ({ entries: [...FIXTURE.entries, github, notes], groups: [scope] }), columns: 140 });
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Agents");
    // The heading says which scope the list reads; the dim line under the group counts what it leaves out.
    expect(f.text()).toMatch(/▾ Claude Code MCP servers\s+1 of 1 {2}user scope and your home folder\n/);
    expect(f.text()).toMatch(/notes\s+stays here\n┃ {7}12 more in 2 project folders stay on this computer \(a repo's \.mcp\.json travels with it\)\n/);
    // all row, Claude Code, Codex, the group header, then github: its detail pane names the transport, what it needs and the secret.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
    await f.until("carries a secret");
    const t = f.text();
    expect(t).toContain("Claude Code MCP servers");
    expect(t).toContain("defined in the agent's config, which travels with the agent's row");
    expect(t).toContain("stdio: npx @modelcontextprotocol/server-github; runs via npx; carries a secret");
    // The macOS-only server is locked off and says why.
    await f.press(KEY.down);
    await f.until("is macOS-only, will not run");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    await f.press(KEY.enter);
    await f.until(BOOT);
    expect(f.text()).toMatch(/Installs\s+Claude Code, neovim, 3 tools plus Homebrew's toolchain, 1 MCP server\n/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === github.id)).toMatchObject({ bring: true });
    expect(saved.entries.find(e => e.id === notes.id)).toMatchObject({ bring: false });
    expect(saved.groups).toEqual([scope]);
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
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until(BOOT);
    await f.press("y");
    await f.until(SEAL_Q(1));
    expect(f.text()).toContain("Enter seals: a snapshot, then a fork to prove it. No leaves the machine up.");
    await f.press("n");
    const result = await run;
    expect(result.code).toBe(1);
    expect(result.handle).toBeUndefined();
    expect(f.hostsClosed).toBe(1);
    expect(f.text()).toContain(`Nothing was sealed. Builder m1 stays up at about $0.11/hr; wsp init --manifest ${recipePath(f.opts.statePath)} attaches to it again, and the sweep stops it once it is six hours old.`);
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
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/8");
    const t = f.text();
    expect(t).toContain("Reading this computer  Identity 3");
    expect(t).toContain("Reading this computer  Identity 3, Shell 2, Editors 1, Toolchains 1, Tools 4, Agents 2, Sign-ins 3");
    expect(t.indexOf("Sign-ins 3")).toBeLessThan(t.indexOf("Found on this computer"));
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
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
    await f.until("1/8");
    const spins = f.text().split("\r").filter(l => l.includes("Reading this computer"));
    expect(spins.length).toBeGreaterThan(1);
    expect(spins.map(l => l.length).filter(n => n > 48)).toEqual([]);
    expect(spins.filter(l => /Identity 3$/.test(l)).length).toBeGreaterThan(0);
    expect(spins.at(-1)).toMatch(/Identity 3, Shell 2.*…$/);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("nothing found on this machine still shows the screens' empty state and reaches the confirm", async () => {
    const f = fake({ collect: async () => ({ entries: [] }) });
    const run = runInit(f.opts, f.io);
    await f.until(BOOT);
    expect(f.text()).toContain("Nothing found to bring");
    expect(f.text()).toContain("--manifest");
    await f.press("n");
    expect((await run).code).toBe(1);
  });
});

describe("wsp init, everything else", () => {
  const found = (): typeof FIXTURE => ({ entries: [...FIXTURE.entries, ...EVERYTHING] });

  it("under 100 columns the rows keep size and role only, so the label has room", async () => {
    const f = fake({ collect: async () => found() });
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Everything else (1.2 MB");
    const screen = f.text().slice(f.text().lastIndexOf("Everything else (1.2 MB"));
    expect(screen).toMatch(/○ demo\s+300 B\s+config\n/);
    expect(screen).toMatch(/○ \.demo-token\s+40 B\s+credential\s+skip\n/);
    expect(screen).not.toContain("2 files");
    expect(screen).not.toContain("2026-08-12");
    // Two cells: sizes end together, role words start together.
    const rowOf = (re: RegExp) => screen.split("\n").find(l => re.test(l))!;
    expect(rowOf(/○ demo /).indexOf("config")).toBe(rowOf(/○ \.demo-token/).indexOf("credential"));
    expect(rowOf(/○ \.big/).indexOf("unknown")).toBe(rowOf(/○ demo /).indexOf("config"));
    // Room for a label of at least thirty characters at eighty columns.
    expect(screen).toMatch(/▾ Keychain, device-bound\s+1\n/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
  });

  it("the eighth screen lists the unclaimed rows unticked with size, files, date and role, answers a credential row per item, and saves both", async () => {
    const f = fake({ collect: async () => found(), columns: 100 });
    mkdirSync(join(f.opts.home, ".config", "demo", "cache"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "demo", "settings.toml"), "theme = 1\n");
    writeFileSync(join(f.opts.home, ".config", "demo", "cache", "blob"), "x".repeat(500));
    writeFileSync(join(f.opts.home, ".demo-token"), "fake-token\n", { mode: 0o600 });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    expect(f.text()).toMatch(/Everything else\s+4\s+1\.2 MB\s+3 can come/);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Everything else (1.2 MB");
    const screen = f.text().slice(f.text().lastIndexOf("Everything else (1.2 MB"));
    // One denominator on the screen: the rows that can come (the found table's "3 can come"); the title carries the size alone.
    expect(screen).toMatch(/^Everything else \(1\.2 MB\)\s+8\/8\n/);
    expect(screen).toMatch(/all\s+0 of 3\n/);
    expect(screen).toMatch(/○ demo\s+300 B\s+2 files\s+2026-08-12\s+config\n/);
    expect(screen).toMatch(/○ \.demo-token\s+40 B\s+1 file\s+2026-08-12\s+credential\s+skip\n/);
    // The role column lines up between a tick row and an answered row, and the size column is right-aligned.
    const rowOf = (re: RegExp) => screen.split("\n").find(l => re.test(l))!;
    const demoRow = rowOf(/○ demo /);
    const tokenRow = rowOf(/○ \.demo-token/);
    const bigRow = rowOf(/○ \.big/);
    expect(demoRow.indexOf("config")).toBe(tokenRow.indexOf("credential"));
    expect(bigRow.indexOf("unknown")).toBe(demoRow.indexOf("config"));
    expect(demoRow.indexOf("300 B") + "300 B".length).toBe(tokenRow.indexOf("40 B") + "40 B".length);
    expect(bigRow.indexOf("1.2 MB") + "1.2 MB".length).toBe(demoRow.indexOf("300 B") + "300 B".length);
    expect(screen).toMatch(/▾ large, review\s+0 of 1 {2}1\.2 MB\n/);
    expect(screen).toMatch(/○ \.big\s+1\.2 MB\s+900 files\s+2026-01-05\s+unknown\n/);
    expect(screen).toMatch(/▾ Keychain, device-bound\s+1\n/);
    expect(screen).toMatch(/○ Raycast\s+stays here\n/);
    expect(screen).toContain("Selected: none");
    expect(screen).toContain("0 ticked\n");
    expect(screen).toContain("large items are listed but never copied without a tick");
    expect(screen).toContain("know what one of these is? add it to the catalog");
    expect(screen).toContain("space tick or copy, skip • ← → fold • enter next • esc back");
    // The all row ticks the plain rows and leaves the large one alone; its count still runs over every row that can come.
    await f.press(KEY.space);
    expect(f.text()).toMatch(/all\s+1 of 3\n/);
    expect(f.text().slice(f.text().lastIndexOf("Selected:"))).toMatch(/Selected: demo\n┃  1 ticked, 300 B\n/);
    await f.press(KEY.space);
    // all row, demo: tick it; .demo-token: skip -> copy (two answers, copy and skip).
    await f.press(KEY.down, KEY.space);
    let last = f.text().slice(f.text().lastIndexOf("Selected:"));
    expect(last).toMatch(/Selected: demo\n┃  1 ticked, 300 B\n/);
    expect(f.text()).toContain("~/.config/demo minus ~/.config/demo/cache");
    expect(f.text()).toContain("looks like config; installed by homebrew");
    await f.press(KEY.down, KEY.space);
    last = f.text().slice(f.text().lastIndexOf("Selected:"));
    expect(last).toMatch(/Selected: demo, \.demo-token\n┃  2 ticked, 340 B\n/);
    expect(f.text()).toContain("copy brings it along; skip leaves it here");
    await f.press(KEY.space, KEY.space);
    expect(f.text().slice(f.text().lastIndexOf("Selected:"))).toMatch(/Selected: demo, \.demo-token\n/);
    await f.press(KEY.enter);

    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"), f.text().lastIndexOf("Recipe saved"));
    expect(summary).toMatch(/Everything else\s+2 of 4\s+340 B\n│\s+\.demo-token\s+copy\n/);
    expect(summary).not.toMatch(/\n│\s+demo\s/);
    expect(summary).toMatch(/Sign-ins\s+2 sign in[^\n]*\n│\s+GitHub CLI login\s+sign in/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);

    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    const everything = saved.entries.filter(e => e.rung === "everything");
    expect(everything.map(e => [e.id, e.bring, e.choice])).toEqual([
      ["everything/.config/demo", true, undefined],
      ["everything/.demo-token", true, "copy"],
      ["everything/.big", false, undefined],
      ["everything/keychain:Raycast", false, undefined],
    ]);
    expect(everything[0]).toMatchObject({ excludes: ["~/.config/demo/cache"], role: "config", files: 2, detail: "looks like config; installed by homebrew" });

    // A re-run from the saved recipe packs the directory minus its cache and the credential file, and skips nothing.
    const again = fake({ yes: true, columns: 140, manifestPath: join(dirs[0]!, "golden-recipe.json"), collect: async () => { throw new Error("collect must not run with --manifest"); } });
    mkdirSync(join(again.opts.home, ".config", "demo", "cache"), { recursive: true });
    writeFileSync(join(again.opts.home, ".config", "demo", "settings.toml"), "theme = 1\n");
    writeFileSync(join(again.opts.home, ".config", "demo", "cache", "blob"), "x".repeat(500));
    writeFileSync(join(again.opts.home, ".demo-token"), "fake-token\n", { mode: 0o600 });
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toMatch(/\d files: identity \d, shell 1, everything 2/);
    // The credential row is not a sign-in: the seal summary lists the two logins, both waiting for the app's terminal under --yes, and never the token file.
    const signIns = again.text().slice(again.text().lastIndexOf("Sign-ins\n"), again.text().lastIndexOf("Secrets\n"));
    expect(signIns).toMatch(/GitHub CLI login\s+skipped/);
    expect(signIns).toMatch(/Claude Code login\s+skipped/);
    expect(signIns).not.toContain(".demo-token");
    const result = JSON.parse(readFileSync(join(dirname(again.opts.statePath), "golden-import.json"), "utf8")) as { files: { bytes: number; skipped: { id: string }[] } };
    expect(result.files.skipped.filter(s => s.id.startsWith("everything/"))).toEqual([]);
    expect(result.files.bytes).toBeGreaterThan(0);
  });

  it("an rc file with a cut secret export is named in the secrets step, skipped under --yes with the reason and recorded, and a failed eighth rung is one warning", async () => {
    // The recipe row carries no secrets field: the names come from the pack, which strips the file as it stands at build time.
    const f = fake({
      yes: true,
      collect: async (_onRung, onNote) => {
        onNote("Everything else could not be read and is left out: EIO");
        return FIXTURE;
      },
    });
    writeFileSync(join(f.opts.home, ".zshrc"), "export A=1\nexport A_KEY=fake\n");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out.split("Everything else could not be read and is left out: EIO").length).toBe(2);
    expect(out.indexOf("could not be read")).toBeLessThan(out.indexOf("Found on this computer"));
    expect(out).toContain("Secrets skipped: A_KEY (~/.zshrc). --yes asks nothing; set them from the app's terminal.");
    expect(out).toMatch(/Secrets\n│\s+A_KEY\s+skipped \(--yes asks nothing; set them from the app's terminal\)\n/);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      secrets: [{ name: "A_KEY", path: "~/.zshrc", state: "skipped", note: "--yes asks nothing; set them from the app's terminal" }],
    });
    // The value never went anywhere: no pty was opened for it.
    expect(f.link.ptys.filter(p => p.created["env"] !== undefined && "WSP_SECRET_LINE" in (p.created["env"] as object))).toEqual([]);
  });

  it("on a terminal each cut secret is asked for hidden and set before any login is checked; the pasted value rides the pty's environment into the machine's secrets file, out of the screen and the run log, and the copied logins' check reads that file first", async () => {
    const f = fake();
    writeFileSync(join(f.opts.home, ".zshrc"), "export A=1\nexport ANTHROPIC_API_KEY=fake\n");
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    // Past the CLI logins heading onto gh: one space opts its copy in, so a copied login's check follows the secrets.
    await f.until("Sign-ins");
    await f.press(KEY.down, KEY.space);
    await f.until(/GitHub CLI login\s+copy/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Secrets were cut from your files. Paste each to set it on the machine, or leave it empty to skip.");
    expect(f.text()).not.toContain("Checking the logins copied to the machine");
    await f.until("cut from ~/.zshrc; the value is set on the machine and never shown here");
    await f.press(..."s3cret-value".split(""), KEY.enter);
    await f.until("ANTHROPIC_API_KEY: set in /etc/profile.d/wsp-secrets.sh on the machine");
    await f.until("Claude Code login: signed in (claude auth login exited 0)");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.secrets).toEqual([{ name: "ANTHROPIC_API_KEY", path: "~/.zshrc", state: "set" }]);
    const out = f.text();
    expect(out.indexOf("Secrets were cut")).toBeGreaterThan(out.indexOf("Ready"));
    expect(out.indexOf("Secrets were cut")).toBeLessThan(out.indexOf("Checking the logins copied to the machine"));
    expect(out.indexOf("Checking the logins copied to the machine")).toBeLessThan(out.indexOf("Ready to seal golden v1"));
    expect(out).toMatch(/Secrets\n│\s+ANTHROPIC_API_KEY\s+set on the machine\n/);
    expect(out).not.toContain("s3cret");
    // The machine's secrets file is read first (nothing there on a fresh builder, no fish), then the one write, and
    // only then the status checks, each with that file sourced.
    const read = f.link.ptys.find(p => p.writes[0]!.startsWith(readCommand()))!;
    expect(read.created["env"]).toEqual({ PS1: "" });
    const pty = f.link.ptys.find(p => p.created["env"] !== undefined && "WSP_SECRET_LINE" in (p.created["env"] as object))!;
    expect(pty.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", WSP_SECRET_LINE: "export ANTHROPIC_API_KEY='s3cret-value'" } });
    expect(pty.writes).toEqual([`${appendCommand(false)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(pty.killed).toBe(true);
    const lines = f.link.ptys.map(p => p.writes[0]!);
    expect(lines.indexOf(pty.writes[0]!)).toBeLessThan(lines.findIndex(l => l.includes("auth status")));
    for (const l of lines.filter(l => l.includes("auth status"))) expect(l.indexOf("[ -r /etc/profile.d/wsp-secrets.sh ] && . /etc/profile.d/wsp-secrets.sh\r")).toBeLessThan(l.indexOf("auth status"));
    // The read, the write, gh's copy check, claude's sign-in.
    expect(f.link.dials).toBe(4);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      logins: [{ id: "logins/gh" }, { id: "logins/claude", state: "signed-in", note: "claude auth login exited 0" }],
      secrets: [{ name: "ANTHROPIC_API_KEY", path: "~/.zshrc", state: "set" }],
    });
    expect(readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8")).not.toContain("s3cret");
  });

  it("a consent row saved as sign in before this round replays as skip: nothing uploads, the summary says skip, the resaved recipe says skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: [...FIXTURE.entries.map(e => ({ ...e, bring: e.id === "identity/git-user" })), ...EVERYTHING.map(e => (e.id === "everything/.demo-token" ? { ...e, bring: true, choice: "machine" } : { ...e, bring: false }))] }));
    const f = fake({ yes: true, manifestPath: path });
    writeFileSync(join(f.opts.home, ".demo-token"), "fake-token\n", { mode: 0o600 });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("1 file: identity 1");
    expect(out).toMatch(/Everything else\s+0 of 4/);
    expect(out).not.toMatch(/\.demo-token\s+sign in/);
    // Only the unticked gh login is a sign-in here; the credential row never is.
    const signIns = out.slice(out.lastIndexOf("Sign-ins\n"), out.lastIndexOf("Secrets\n"));
    expect(signIns).toMatch(/GitHub CLI login\s+skipped/);
    expect(signIns).not.toContain(".demo-token");
    const saved = loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "everything/.demo-token")).toMatchObject({ bring: false, choice: "skip" });
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")).files.skipped).toEqual([]);
  });

  it("a consented .netrc copies on a copy answer and an unconsented .env is locked on the screen, out of the summary and refused by the plan, all saying the same", async () => {
    const netrc = { rung: "everything" as const, id: "everything/.netrc", label: ".netrc", paths: ["~/.netrc"], bytes: 30, default: "skip" as const, consent: true, role: "credential" as const, files: 1, mtime: Date.UTC(2026, 7, 12, 12), detail: "credential-shaped" };
    const env = { rung: "everything" as const, id: "everything/.env", label: ".env", paths: ["~/.env"], bytes: 20, default: "skip" as const, role: "unknown" as const, files: 1, mtime: Date.UTC(2026, 7, 12, 12), detail: "nothing says what this is" };
    const f = fake({ collect: async () => ({ entries: [...FIXTURE.entries, netrc, env, ...EVERYTHING] }), columns: 100 });
    writeFileSync(join(f.opts.home, ".netrc"), "machine api.example.com login me password fake-netrc\n", { mode: 0o600 });
    writeFileSync(join(f.opts.home, ".env"), "TOKEN=fake-env\n");
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    expect(f.text()).toMatch(/Everything else\s+6\s+1\.2 MB\s+4 can come/);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Everything else (1.2 MB");
    const screen = f.text().slice(f.text().lastIndexOf("Everything else (1.2 MB"));
    expect(screen).toMatch(/○ \.env\s+stays here\n/);
    expect(screen).toMatch(/○ \.netrc\s+30 B\s+1 file\s+2026-08-12\s+credential\s+skip\n/);
    // all row, then .netrc: skip -> copy. The locked .env shows the plan's note when highlighted.
    await f.press(KEY.down, KEY.space);
    expect(f.text().slice(f.text().lastIndexOf("Selected:"))).toMatch(/Selected: \.netrc\n┃  1 ticked, 30 B\n/);
    await f.press(KEY.down);
    expect(f.text()).toContain(".env files are never copied; set the values on the machine");
    await f.press(KEY.enter);
    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"), f.text().lastIndexOf("Recipe saved"));
    expect(summary).toMatch(/Everything else\s+1 of 6\s+30 B\n│\s+\.netrc\s+copy\n/);
    expect(summary).not.toMatch(/\n│\s+\.env\s/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "everything/.netrc")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.entries.find(e => e.id === "everything/.env")).toMatchObject({ bring: false });

    // The plan agrees: a re-run copies the .netrc and, even with bring forced on in the file, never the .env.
    const path = join(dirs[0]!, "golden-recipe.json");
    writeFileSync(path, JSON.stringify({ entries: saved.entries.map(e => (e.id === "everything/.env" ? { ...e, bring: true } : e)) }));
    const again = fake({ yes: true, columns: 140, manifestPath: path, collect: async () => { throw new Error("collect must not run with --manifest"); } });
    writeFileSync(join(again.opts.home, ".netrc"), "machine api.example.com login me password fake-netrc\n", { mode: 0o600 });
    writeFileSync(join(again.opts.home, ".env"), "TOKEN=fake-env\n");
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toMatch(/Everything else\s+1 of 6/);
    expect(again.text()).toMatch(/files: identity \d, shell 1, everything 1/);
    const result = JSON.parse(readFileSync(join(dirname(again.opts.statePath), "golden-import.json"), "utf8")) as { files: { skipped: { id: string; note: string }[] } };
    expect(result.files.skipped.filter(s => s.id.startsWith("everything/"))).toEqual([]);
  });

  it("a directory named .env on this computer is offered as a plain row, ticks, and is copied", async () => {
    const env = { rung: "everything" as const, id: "everything/.env", label: ".env", paths: ["~/.env"], bytes: 60, default: "skip" as const, role: "unknown" as const, files: 2, mtime: Date.UTC(2026, 7, 12, 12), detail: "nothing says what this is" };
    const f = fake({ collect: async () => ({ entries: [...FIXTURE.entries, env, ...EVERYTHING] }), columns: 100 });
    mkdirSync(join(f.opts.home, ".env", "bin"), { recursive: true });
    writeFileSync(join(f.opts.home, ".env", "bin", "activate"), "export VIRTUAL_ENV=$HOME/.env\n");
    writeFileSync(join(f.opts.home, ".env", "pyvenv.cfg"), "home = /usr/bin\n");
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    expect(f.text()).toMatch(/Everything else\s+5\s+1\.2 MB\s+4 can come/);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Everything else (1.2 MB");
    const screen = f.text().slice(f.text().lastIndexOf("Everything else (1.2 MB"));
    expect(screen).toMatch(/○ \.env\s+60 B\s+2 files\s+2026-08-12\s+unknown\n/);
    expect(screen).not.toContain(".env files are never copied");
    expect(screen).not.toMatch(/\.env\s+stays here/);
    await f.press(KEY.down, KEY.space);
    expect(f.text()).toContain("nothing says what this is");
    await f.press(KEY.enter);
    await f.until(BOOT);
    expect(f.text().slice(f.text().lastIndexOf("Summary"))).toMatch(/Everything else\s+1 of 5\s+60 B/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    const again = fake({ yes: true, columns: 140, manifestPath: join(dirs[0]!, "golden-recipe.json"), collect: async () => { throw new Error("collect must not run with --manifest"); } });
    mkdirSync(join(again.opts.home, ".env", "bin"), { recursive: true });
    writeFileSync(join(again.opts.home, ".env", "bin", "activate"), "export VIRTUAL_ENV=$HOME/.env\n");
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toMatch(/files: identity \d, shell 1, everything 1/);
    const result = JSON.parse(readFileSync(join(dirname(again.opts.statePath), "golden-import.json"), "utf8")) as { files: { skipped: { id: string }[] } };
    expect(result.files.skipped.filter(s => s.id.startsWith("everything/"))).toEqual([]);
  });

  it("a credential row ticked in a recipe without its answer is not consent: nothing of it uploads and the saved recipe says skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: [...FIXTURE.entries.map(e => ({ ...e, bring: e.id === "identity/git-user" })), ...EVERYTHING.map(e => ({ ...e, bring: e.id === "everything/.demo-token" }))] }));
    const f = fake({ yes: true, manifestPath: path });
    writeFileSync(join(f.opts.home, ".demo-token"), "fake-token\n", { mode: 0o600 });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("1 file: identity 1");
    expect(f.text()).toMatch(/Everything else\s+0 of 4/);
    const saved = loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "everything/.demo-token")).toMatchObject({ bring: false, choice: "skip" });
    const result = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"));
    expect(result.files.skipped).toEqual([]);
  });
});

describe("wsp init, the sign-in stage", () => {
  const CODEX_MANIFEST: Manifest = {
    entries: [
      FIXTURE.entries[0]!,
      { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: ["~/.codex/auth.json"], bytes: 300, default: "skip" },
      { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "skip" },
    ],
  };

  it("a login the status check does not confirm is offered a retry, then the table's fallback, then a skip; o opens the page here and arms auto-open for that command only; the skip lands in the notes", async () => {
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Tools");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).toMatch(/Codex login\s+sign in/);
    await f.press(KEY.enter);
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

    // kubectl has no sign-in: skipped with the reason, no pty.
    await f.until("kubectl config: skipped (kubectl has no sign-in; copy the kubeconfig instead)");
    await f.until(/kubectl config\s+skipped\s+kubectl has no sign-in/);
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
    const result = await run;
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Codex login\s+skipped\s+skipped by you/);
    // Three login ptys (default, retry, fallback), no status run after any of them and no check script since nothing was copied; o never reached the machine.
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["exec codex login || exit\r", "exec codex login || exit\r", "exec codex login --device-auth || exit\r"]);
    expect(f.link.ptys.flatMap(p => p.writes.slice(1))).toEqual(["\x03", "\x03", "\x03"]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [
        { id: "logins/codex", label: "Codex login", state: "skipped", command: "codex login --device-auth", note: "skipped by you" },
        { id: "logins/kube", label: "kubectl config", state: "skipped", note: "kubectl has no sign-in; copy the kubeconfig instead" },
      ],
    });
    expect(result.logins?.map(l => l.state)).toEqual(["skipped", "skipped"]);
    expect(out).not.toMatch(/—/);
    // o opened the page twice; the device URL, the second o, then the app after the seal.
    expect(f.opened).toEqual([DEVICE_URL, DEVICE_URL, expect.stringMatching(URL_RE)]);
    // The seal stamps their states on the version.
    expect((await f.runtimes.at(-1)!.golden.get())?.versions[0]?.logins).toEqual([
      { name: "Codex login", state: "skipped" },
      { name: "kubectl config", state: "skipped" },
    ]);
  });

  it("a tool that is not on the machine (exit 127) is skipped with that reason, its status command never runs, and nothing is asked", async () => {
    const f = fake({ missing: true, collect: async () => CODEX_MANIFEST });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Tools");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Codex login: skipped (codex is not on the machine)");
    await sealIt(f);
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
    const f = fake({ signedIn: false, hold: true, collect: async () => CLOUDFLARED_MANIFEST });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Tools");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    await f.press(KEY.enter);
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
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Tools");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    await f.press(KEY.enter);
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
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.logins?.map(l => [l.state, l.note])).toEqual([["skipped", "skipped by you"], ["skipped", "kubectl has no sign-in; copy the kubeconfig instead"]]);
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
    const f = fake({ yes: true, collect: async () => CODEX_MANIFEST });
    await runInit(f.opts, f.io);
    expect(f.hooks[0]!.openLine("task-1", "github.com", "https://github.com/login/device")).toBe(lines[0]);
  });

  it("when the machine's terminal cannot be reached the login is not signed in with the reason, can be skipped, and the seal still comes", async () => {
    const f = fake({ collect: async () => CODEX_MANIFEST, daemon: async () => { throw new Error("no daemon token"); } });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Tools");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Codex login: not signed in (no daemon token)");
    await f.until("r retry   f retry with codex login --device-auth   s skip");
    await f.press("s");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.logins).toEqual([
      { id: "logins/codex", label: "Codex login", state: "skipped", command: "codex login", note: "skipped by you" },
      { id: "logins/kube", label: "kubectl config", state: "skipped", note: "kubectl has no sign-in; copy the kubeconfig instead" },
    ]);
    // The typed key never echoes into the next line.
    expect(f.text()).not.toMatch(/\ns[│◇]/);
  });
});

describe("wsp init, logins copied to the machine", () => {
  const COPIED_MANIFEST: Manifest = {
    entries: [
      FIXTURE.entries[0]!,
      { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], bytes: 200, default: "skip" },
      { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "bring" },
    ],
  };
  /** The one check script for the two copied logins. */
  const CHECKS = (pty: FakePty): string => typed(pty, "gh auth status", "kubectl config current-context 2>/dev/null");

  /** gh on the fake builder: its status names the copied token invalid (with `stale`, the second account's beside a
   * good first one); gh auth login there exits 0. */
  function ghOnBuilder(f: Fake, o: { missing?: boolean } = {}): void {
    const checks = answersChecks(f.link, command => {
      if (command.includes("kubectl config current-context")) return { output: "minikube", exitCode: 0 };
      if (o.missing) return { output: "sh: gh: not found", exitCode: 127 };
      return { output: "X Failed to log in to github.com account someone (keyring)\n- The token in /root/.config/gh/hosts.yml is invalid.", exitCode: 1 };
    });
    f.link.script = (pty, line) => {
      if (checks(pty, line)) return;
      if (line.startsWith("exec gh auth login")) {
        f.link.data(pty, `Press Enter to open ${DEVICE_URL} in your browser...\r\n`);
        f.link.exit(pty, 0);
      }
    };
  }

  /** Through the screens and the boot question, gh opted into copy with one space on its row; the run itself is handed back unawaited. */
  async function toTheBuilder(f: Fake): Promise<{ run: ReturnType<typeof runInit> }> {
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Tools");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).toMatch(/GitHub CLI login\s+sign in/);
    expect(f.text()).toMatch(/kubectl config\s+copy/);
    await f.press(KEY.down, KEY.space);
    await f.until(/GitHub CLI login\s+copy/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("y");
    return { run };
  }

  /** The same laptop saved as a recipe with both logins answered copy: under --yes a fresh collection would sign a Keychain login in on the machine instead. */
  function savedAsCopy(f: Fake): void {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    f.opts.manifestPath = join(dir, "recipe.json");
    writeFileSync(f.opts.manifestPath, JSON.stringify({ entries: COPIED_MANIFEST.entries.map(e => (e.rung === "logins" ? { ...e, bring: true, choice: "copy" } : { ...e, bring: true })) }));
  }

  it("a copied login whose status check fails is offered the machine sign-in, which lands it as signed in; a copied kubeconfig is proved by its context", async () => {
    const f = fake({ collect: async () => COPIED_MANIFEST });
    ghOnBuilder(f);
    const { run } = await toTheBuilder(f);
    await f.until("GitHub CLI login: not signed in (copied, but gh auth status says not signed in)");
    await f.until("kubectl config: signed in (copied; context minikube; kubectl config current-context)");
    await f.until("GitHub CLI login  r sign in on the machine   s skip");
    expect(f.text()).not.toContain("Signing in on the machine");
    await f.press("r");
    await f.until(/GitHub CLI login\s+gh auth login\n/);
    await f.until("GitHub CLI login: signed in (gh auth login exited 0)");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    // The one check script for both copied logins, then the sign-in pty; its exit is the row's proof.
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([CHECKS(f.link.ptys[0]!), "exec gh auth login || exit\r"]);
    expect(result.logins).toEqual([
      { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", command: "gh auth login", exit: 0, note: "gh auth login exited 0" },
      { id: "logins/kube", label: "kubectl config", state: "signed-in", note: "copied; context minikube; kubectl config current-context" },
    ]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [
        { id: "logins/gh", state: "signed-in", note: "gh auth login exited 0" },
        { id: "logins/kube", state: "signed-in" },
      ],
    });
    expect((await f.runtimes.at(-1)!.golden.get())?.versions[0]?.logins).toEqual([
      { name: "GitHub CLI login", state: "signed-in" },
      { name: "kubectl config", state: "signed-in" },
    ]);
  });

  it("two gh accounts on this computer are read from the Keychain one each; a copy whose status lists one of them as failed is not signed in until the machine sign-in mends it", async () => {
    const f = fake({ collect: async () => COPIED_MANIFEST });
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        other:\n        Zingzy:\n    user: Zingzy\n");
    ghOnBuilder(f);
    const { run } = await toTheBuilder(f);
    await f.until("GitHub CLI login: not signed in (copied, but gh auth status says not signed in)");
    await f.until("GitHub CLI login  r sign in on the machine   s skip");
    await f.press("r");
    await f.until("GitHub CLI login: signed in (gh auth login exited 0)");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com (other)", "gh:github.com (Zingzy)"]);
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([CHECKS(f.link.ptys[0]!), "exec gh auth login || exit\r"]);
    expect(result.logins?.[0]).toEqual({ id: "logins/gh", label: "GitHub CLI login", state: "signed-in", command: "gh auth login", exit: 0, note: "gh auth login exited 0" });
  });

  it("a gh account with no Keychain item is left behind: the copy goes on without it, the row detail names it, and the check passes without it", async () => {
    const f = fake({ collect: async () => COPIED_MANIFEST });
    f.opts.secrets = {
      read: async (service, account) => {
        f.reads.push(`${service} (${account})`);
        if (account === "other") throw new Error(`Command failed: security find-generic-password -s ${service} -a other -w\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n`);
        return "gho_fake";
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        other:\n        Zingzy:\n    user: Zingzy\n");
    const { run } = await toTheBuilder(f);
    await f.until("GitHub CLI login: signed in (copied; gh auth status; other left behind: no token in the Keychain)");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    const out = f.text();
    expect(f.reads).toEqual(["gh:github.com (other)", "gh:github.com (Zingzy)"]);
    const said = out.indexOf("GitHub CLI login: other left behind: no token in the Keychain (security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.).");
    expect(said).toBeGreaterThan(-1);
    expect(said).toBeLessThan(out.search(BOOT));
    expect(out).not.toContain("Keychain read failed");
    // The row stays a copy, so the recipe is not replanned and the check ran once.
    expect(f.recipes).toHaveLength(1);
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("copy");
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([CHECKS(f.link.ptys[0]!)]);
    expect(result.logins?.[0]).toEqual({ id: "logins/gh", label: "GitHub CLI login", state: "signed-in", note: "copied; gh auth status", left: "other left behind: no token in the Keychain" });
    const landed = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"));
    expect((landed.files.skipped as { id: string }[]).filter(s => s.id === "logins/gh")).toEqual([{ id: "logins/gh", path: "Keychain: gh:github.com (other)", note: "other left behind: no token in the Keychain" }]);
    expect(landed.logins[0]).toMatchObject({ id: "logins/gh", state: "signed-in", left: "other left behind: no token in the Keychain" });
  });

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
      const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
      dirs.push(dir);
      f.opts.manifestPath = join(dir, "recipe.json");
      writeFileSync(f.opts.manifestPath, JSON.stringify({ entries: withHelper.entries.map(e => ({ ...e, bring: true, ...(e.rung === "logins" ? { choice: "copy" } : {}) })) }));
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
    expect(out).toContain("Claude Code login: signed in (copied; claude auth status)");
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
    expect(bare.text()).toContain(`Claude Code login: signed in (copied; claude auth status; ${bareNote})`);
    expect(bareResult.logins?.[0]).toEqual({ id: "logins/claude", label: "Claude Code login", state: "signed-in", note: "copied; claude auth status", left: bareNote });
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

  it("a login row's detail says what its default does: a browser or device flow names the command sign in runs, a key gets the plain line, a tool with no sign-in says so", () => {
    const why = (id: string, dflt: "bring" | "skip" = "skip", detail?: string) => selectItem({ rung: "logins", id: `logins/${id}`, label: id, group: "CLI logins", paths: ["~/x"], bytes: 1, default: dflt, ...(detail !== undefined ? { detail } : {}) }).detail[1];
    expect(why("gh")).toBe("sign in runs gh auth login after the build; copy brings it along");
    expect(why("gcloud")).toBe("sign in runs gcloud auth login after the build; copy brings it along");
    // Hermes has a device flow but its keys travel only by copy, so the collector starts it as a copy and says why.
    expect(why("hermes", "bring", "the keys in ~/.hermes/.env travel only by copy")).toBe("the keys in ~/.hermes/.env travel only by copy; sign in runs hermes auth");
    expect(why("hermes", "bring")).toBe("copy brings it along; sign in runs hermes auth");
    expect(why("opencode", "bring")).toBe("copy brings it along; sign in does it in this terminal after the build");
    expect(why("kube", "bring")).toBe("kubectl has no sign-in; copy the kubeconfig instead");
    expect(why("some-new-tool", "bring")).toBe("copy brings it along; sign in does it in this terminal after the build");
    // Every line fits the detail pane of an 80 column terminal.
    for (const id of ["gh", "gcloud", "wrangler", "cloudflared", "vercel", "aws", "codex", "gemini", "pi"]) expect(why(id)!.length, id).toBeLessThanOrEqual(76);
    expect(why("hermes", "bring", "the keys in ~/.hermes/.env travel only by copy")!.length).toBeLessThanOrEqual(76);
  });

  it("the Claude Code login row explains the OAuth rule only when the OAuth credential is on it; a row of API key sources gets the plain login line", () => {
    const claude = (paths: string[], detail: string) => selectItem({ rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths, bytes: 0, default: "bring", detail }).detail[1];
    expect(claude(["Keychain: Claude Code-credentials", "Helper: ~/.claude/settings.json"], "Claude Code uses the apiKeyHelper in ~/.claude/settings.json; also found: OAuth credentials")).toBe(
      "Claude Code uses the apiKeyHelper in ~/.claude/settings.json; also found: OAuth credentials; Anthropic's terms forbid passing the OAuth credential along, so with it alone the default is to sign in on the machine.",
    );
    expect(claude(["~/.claude/.credentials.json"], "Claude Code uses OAuth credentials")).toContain("Anthropic's terms forbid passing the OAuth credential along");
    expect(claude(["Helper: ~/.claude/settings.json"], "Claude Code uses the apiKeyHelper in ~/.claude/settings.json")).toBe("Claude Code uses the apiKeyHelper in ~/.claude/settings.json; copy brings it along; sign in does it in this terminal after the build");
    expect(claude([], "Claude Code uses the API key exported in ~/.zshrc (set on the machine in the secrets step if ~/.zshrc comes along)")).toBe(
      "Claude Code uses the API key exported in ~/.zshrc (set on the machine in the secrets step if ~/.zshrc comes along); copy brings it along; sign in does it in this terminal after the build",
    );
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

  it("a copied login whose status check fails can be skipped instead; the skip is what the seal records", async () => {
    const f = fake({ collect: async () => COPIED_MANIFEST });
    ghOnBuilder(f);
    const { run } = await toTheBuilder(f);
    await f.until("GitHub CLI login  r sign in on the machine   s skip");
    await f.press("s");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([CHECKS(f.link.ptys[0]!)]);
    expect(result.logins?.[0]).toEqual({ id: "logins/gh", label: "GitHub CLI login", state: "skipped", note: "skipped by you" });
    expect((await f.runtimes.at(-1)!.golden.get())?.versions[0]?.logins?.[0]).toEqual({ name: "GitHub CLI login", state: "skipped" });
  });

  it("under --yes a copied login is still checked and nothing is asked: a failed check is not signed in", async () => {
    const f = fake({ yes: true });
    savedAsCopy(f);
    ghOnBuilder(f);
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.text()).toContain("GitHub CLI login: not signed in (copied, but gh auth status says not signed in)");
    expect(f.text()).not.toContain("r sign in on the machine");
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([CHECKS(f.link.ptys[0]!)]);
    expect(result.logins).toEqual([
      { id: "logins/gh", label: "GitHub CLI login", state: "not-signed-in", note: "copied, but gh auth status says not signed in" },
      { id: "logins/kube", label: "kubectl config", state: "signed-in", note: "copied; context minikube; kubectl config current-context" },
    ]);
  });

  it("a copied login whose tool is not on the machine stays copied with that reason; no sign-in is offered", async () => {
    const f = fake({ yes: true });
    savedAsCopy(f);
    ghOnBuilder(f, { missing: true });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.text()).toContain("GitHub CLI login: copied (not verified: gh is not on the machine)");
    expect(f.text()).not.toContain("r sign in on the machine");
    expect(result.logins?.[0]).toEqual({ id: "logins/gh", label: "GitHub CLI login", state: "copied", command: "gh auth status", exit: 127, note: "not verified: gh is not on the machine" });
  });

  it("a login with no table row runs a bare shell on the machine; after it ends unclean the offer is a retry, since a pty has run", async () => {
    const SHELL_MANIFEST: Manifest = { entries: [FIXTURE.entries[0]!, { rung: "logins", id: "logins/foo", label: "foo login", group: "CLI logins", paths: ["~/.foo/auth.json"], bytes: 100, default: "skip" }] };
    const f = fake({ collect: async () => SHELL_MANIFEST });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).toMatch(/foo login\s+sign in/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("y");
    await f.until(/foo login\s+a shell on the machine; type the tool's sign-in command, then exit\n/);
    // No command line is typed for a shell, so the fake exits it by hand, unclean.
    for (let i = 0; i < 200 && f.link.ptys.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    expect(f.link.ptys.at(-1)!.writes).toEqual([]);
    f.link.exit(f.link.ptys.at(-1)!, 1);
    await f.until("foo login: not verified (no status command known for foo; exit 1)");
    await f.until("foo login  r retry   s skip");
    await f.press("s");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.logins).toEqual([{ id: "logins/foo", label: "foo login", state: "skipped", exit: 1, note: "skipped by you" }]);
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
    expect(out).toMatch(/^◇\s+Open http:\/\/127\.0\.0\.1:4400\/$/m);
    expect(out).not.toContain("Opened http");
    // The builder, its smoke fork, the first workspace.
    expect(f.backends[0]!.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_golden-v1", true], ["snap_golden-v1", false]]);
    expect((await f.runtimes.at(-1)!.workspaces.list()).map(w => w.name)).toEqual(["first"]);
    expect(f.opened).toEqual([]);
    // The gh login has a device flow, so it starts as a sign-in on the machine: nobody is here to run it or to click
    // macOS's consent dialog, so the Keychain is never asked and the sign-in is skipped for the app's terminal.
    expect(f.reads).toEqual([]);
    expect(out).toMatch(/GitHub CLI login\s+sign in/);
    expect(result.logins?.find(l => l.id === "logins/gh")?.state).toBe("skipped");
    expect(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("machine");
    expect(out).not.toContain("from your Keychain");
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
    // The copied gh login is checked on the builder with nobody here; the one sign-in chosen for the machine is skipped and said so.
    expect(f.text()).toContain("GitHub CLI login: signed in (copied; gh auth status)");
    expect(f.text()).toContain("Sign-ins on the machine skipped: Claude Code login. No terminal to sign in from; use the app's terminal.");
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([typed(f.link.ptys[0]!, "gh auth status")]);
    expect(f.link.dials).toBe(1);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [
        { id: "logins/gh", state: "signed-in", note: "copied; gh auth status" },
        { id: "logins/claude", state: "skipped", note: "no terminal to sign in from; use the app's terminal" },
      ],
    });
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
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: FIXTURE.entries.map(e => (e.id === "logins/gh" ? { ...e, paths: ["~/.config/gh/hosts.yml"], bring: true, choice: "copy" } : { ...e, bring: e.id === "identity/git-user" })) }));
    const f = fake({ yes: true, manifestPath: path });
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    oauth_token: gho_in_file\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.reads).toEqual([]);
    expect(f.text()).not.toContain("Keychain read failed");
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("copy");
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")).files.skipped).toEqual([]);
  });

  it("when no ticked agent can be installed the run is refused before the boot question, naming each agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    const zed = { rung: "agents", id: "agents/zed", label: "Zed", paths: [], bytes: 0, default: "bring", bring: true };
    // gh is ticked as copy with its Keychain item, so a read would be asked for if the refusal came later.
    writeFileSync(path, JSON.stringify({ entries: [...FIXTURE.entries.map(e => (e.id === "logins/gh" ? { ...e, bring: true, choice: "copy" } : { ...e, bring: e.id === "identity/git-user" })), zed] }));
    const f = fake({ yes: true, manifestPath: path });
    f.opts.secrets = {
      read: async service => {
        f.reads.push(service);
        throw new Error("security: User canceled the operation.");
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toContain("Zed: no installer known");
    expect(out).toContain("Nothing was booted. Untick those agents or add one with an installer");
    expect(out).not.toMatch(BOOT);
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
    // The refusal is a free exit before any consent dialog: the Keychain was never asked and the recipe keeps its answers.
    expect(f.reads).toEqual([]);
    expect(out).not.toContain("Keychain read failed");
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("copy");
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

  it("--yes with --manifest takes the file's ticks, asks nothing, prints the address and never opens a browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    // The logins are answered skip outright: a sign-in answer would tick the row of the command it needs.
    const saved = { entries: FIXTURE.entries.map(e => ({ ...e, bring: e.id === "identity/git-user" || e.id === "shell/zshrc", ...(e.rung === "logins" ? { choice: "skip" } : {}) })) };
    writeFileSync(path, JSON.stringify(saved));
    const f = fake({ tty: false, yes: true, manifestPath: path, collect: async () => { throw new Error("collect must not run with --manifest"); } });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).toMatch(URL_RE);
    expect(out).toContain("Ready");
    expect(out).toContain("Golden v1 sealed.");
    expect(f.opened).toEqual([]);
    // No agent ticked: the harness installs nothing and names nothing; the two files still travel.
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log).toContain("true");
    expect(log.some(c => c.includes(GOLDEN_SETUP))).toBe(false);
    expect(log.some(c => c.includes("tar xzf"))).toBe(true);
    // The zshrc tick brings zsh: the setup step ends on the shell line, after the files were packed.
    expect(log.some(c => c.includes('chsh -s "$(command -v zsh)" "$(id -un)"'))).toBe(true);
    // Off a terminal a step prints once, done, with its whole detail and how long it took two spaces after it: no edge to cut at or pad to.
    expect(out).toMatch(/Setup applied\s+zsh installed as the login shell  \d+\.\ds$/m);
    expect(out).toMatch(/Files uploaded\s+[\d.]+ (B|KB) in [\d.]+s  \d+\.\ds$/m);
    expect(f.recipes[0]!.envs).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    const written = loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json"));
    expect(written.entries.filter(e => e.bring).map(e => e.id)).toEqual(["identity/git-user", "shell/zshrc"]);
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
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: FIXTURE.entries.map(e => ({ ...e, bring: e.id === "agents/codex" ? true : e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    const f = fake({ yes: true, manifestPath: path });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("brew install jq") ? { exitCode: 1, stdout: "", stderr: "curl: no route" } : guestAnswer(cmd));
      f.backends.push(backend);
      f.recipes.push(recipe);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    // The tools, their shared deps and neovim from the Editors rung; the failed formula is named alone.
    expect(out).toMatch(/Tools installed\s+7 installed, 1 failed/);
    expect(out).toMatch(/Agents installed\s+Claude Code, Codex installed/);
    expect(out).toContain("Ready");
    // The stage line is cut to the width; the names come back in full under the tally.
    const tally = out.slice(out.indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 9 installed, 1 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "jq failed: curl: no route",
    ]);
    expect(f.recipes[0]!.import?.node).toMatchObject({ floor: 16, agents: ["Codex"] });
  });

  it("a machine context that did not land is counted and named in the tally, not the end of the build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: FIXTURE.entries.map(e => ({ ...e, bring: e.id === "agents/codex" ? true : e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    const f = fake({ yes: true, manifestPath: path });
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
      expect.stringMatching(/^Tools, agents and machine context: 10 installed, 1 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "machine context failed: write failed: vault import untar failed (exit 2): tar: etc/wsp: Cannot mkdir: Read-only file system",
    ]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({ context: [], contextFailure: expect.stringMatching(/^write failed: vault import untar failed/) });
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

    const f = fake({ yes: true, tty: false, home: first.opts.home, manifestPath: recipePath(first.opts.statePath) });
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

  it("a volatile file with changed bytes still attaches and is uploaded again on attach; a changed non-volatile file still refuses and is named", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    const home = first.opts.home;
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {} } }));
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const manifestPath = join(dir, "recipe.json");
    writeFileSync(manifestPath, JSON.stringify({ entries: [
      { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 20, default: "bring", required: true, bring: true },
      // A row the catalog does not know keeps its saved list; Codex is ticked beside it so an agent installs.
      { rung: "agents", id: "agents/zed", label: "Zed", paths: ["~/.claude.json"], volatile: ["~/.claude.json"], bytes: 30, default: "bring", bring: true },
      { rung: "agents", id: "agents/codex", label: "Codex", paths: ["~/.codex/config.toml"], bytes: 30, default: "bring", bring: true },
    ] }));
    first.opts.manifestPath = manifestPath;
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    // The person's files untar under /root; the machine context archive untars at the root and is not counted here.
    const uploads = () => shared.machines[0]!.execLog.filter(c => c.includes("tar xzf - -C '/root'")).length;
    expect(uploads()).toBe(1);

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {}, two: {} } }));
    const f = fake({ yes: true, tty: false, home, manifestPath });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    // Off a terminal the detail is cut at 80 columns, so the size and time may not survive; the path and the word do.
    expect(out).toMatch(/Files uploaded\s+~\/\.claude\.json re-imported/);
    expect(out).not.toContain("still running on the account");
    expect(uploads()).toBe(2);
    expect(shared.machines).toHaveLength(1);

    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Someone Else\n");
    const g = fake({ yes: true, tty: false, home, manifestPath });
    g.opts.runtime = recipe => {
      g.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(g);
    expect(g.text()).toMatch(/built from a different recipe: ~\/\.gitconfig changed$/m);
    expect(g.text()).toContain("Stopped default (m1).");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("a recipe saved before the volatile list existed still attaches once ~/.claude.json moved: the catalog supplies the list, the file is re-imported and never reads as gone", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    const home = first.opts.home;
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {} } }));
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const manifestPath = join(dir, "recipe.json");
    writeFileSync(manifestPath, JSON.stringify({ entries: [
      { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 20, default: "bring", required: true, bring: true },
      { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude/settings.json", "~/.claude.json"], bytes: 30, default: "bring", bring: true },
    ] }));
    first.opts.manifestPath = manifestPath;
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    await bootedOnly(first);
    const [recorded] = (await store.list("builders")) as { import: { recipe: { files: { path: string; volatile?: boolean }[] } } }[];
    expect(recorded!.import.recipe.files.map(f => [f.path, f.volatile])).toEqual([["~/.claude.json", true], ["~/.claude/settings.json", undefined], ["~/.gitconfig", undefined]]);

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {}, two: {} } }));
    const f = fake({ yes: true, tty: false, home, manifestPath });
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

    const f = fake({ yes: true, tty: false, home: first.opts.home, manifestPath: recipePath(first.opts.statePath) });
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
    const path = recipePath(first.opts.statePath);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { entries: { id: string; bring?: boolean }[] };
    for (const e of saved.entries) if (e.id === "agents/codex") e.bring = true;
    writeFileSync(path, JSON.stringify(saved));

    const f = fake({ yes: true, tty: false, home: first.opts.home, manifestPath: path });
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
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
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

  it("a Keychain refusal rehashes the recipe the builder carries, so wsp init --manifest on the saved recipe attaches after a crash", async () => {
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

    const f = fake({ yes: true, tty: false, home: first.opts.home, manifestPath: recipePath(first.opts.statePath) });
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
        if (!cmd.includes("brew install jq")) return guestAnswer(cmd);
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
        if (!cmd.includes("brew install jq")) return guestAnswer(cmd);
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
    expect(out).toMatch(/Stopped between stages\. Your earlier builder default \(m1\) was not stopped: it has a first life worth keeping and stays up at about \$\d+\.\d\d\/hr\. wsp init --manifest .*golden-recipe\.json attaches to it again; the sweep stops it once it is six hours old\./);
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

describe("editorsIntro", () => {
  const ed = (id: string, paths: string[] = []): ManifestEntry => ({ rung: "editors", id, label: id, paths, bytes: 0, default: "bring" });
  it("names the terminal editors on the screen, says whether their config comes, and adds the remote editors' line only when their rows are there", () => {
    expect(editorsIntro([ed("editors/nvim", ["~/.config/nvim"]), ed("editors/helix"), ed("editors/vim", ["~/.vimrc"]), ed("editors/vscode", ["~/.config/Code/User/settings.json"]), ed("editors/cursor-ext/a.b")])).toEqual([
      "neovim, helix and vim are installed on the machine with the config found here; they run in the workspace's terminal.",
      "VS Code and Cursor rows are settings and extension names, used only if you open this machine from your editor over SSH; nothing runs here.",
    ]);
    expect(editorsIntro([ed("editors/helix"), ed("editors/emacs")])).toEqual(["helix and emacs are installed on the machine; they run in the workspace's terminal."]);
    expect(editorsIntro([ed("editors/vscode-ext/a.b")])).toEqual(["VS Code rows are settings and extension names, used only if you open this machine from your editor over SSH; nothing runs here."]);
    expect(editorsIntro([ed("editors/vscode-insiders", ["~/Library/Application Support/Code - Insiders/User/settings.json"]), ed("editors/vscode-insiders-ext/a.b")])).toEqual([
      "VS Code Insiders rows are settings and extension names, used only if you open this machine from your editor over SSH; nothing runs here.",
    ]);
    expect(editorsIntro([])).toEqual([]);
  });
});

describe("summaryNote", () => {
  it("the Machine disk line adds files, Homebrew's toolchain, the formulae's closures and the agents against the room, and names what has no size", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/jq", "tools/npm/pnpm", "agents/claude", "agents/codex"]);
    const brew = new Map([
      ["gh", { name: "gh", fullName: "gh", deps: [], bytes: 50 * 1024 * 1024, macosOnly: false }],
      ["jq", { name: "jq", fullName: "jq", deps: ["oniguruma"], bytes: 2 * 1024 * 1024, macosOnly: false }],
      ["oniguruma", { name: "oniguruma", fullName: "oniguruma", deps: [], bytes: 1024 * 1024, macosOnly: false }],
    ]);
    const lines = summaryNote(FIXTURE, ticks, new Map(), 200, 300 * 1024 * 1024, brew);
    // 300 MB files + 1024 toolchain + 53 tools + 663 agents + 50 assumed for pnpm = 2090 MiB.
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
    const ticks = new Set(["tools/brew/gh", "tools/brew/jq", "tools/npm/pnpm", "agents/claude"]);
    const narrow = summaryNote(FIXTURE, ticks, new Map(), 48);
    const at = narrow.indexOf("Installs  Claude Code, 3 tools plus");
    expect(at).toBeGreaterThan(-1);
    expect(narrow[at + 1]).toBe("          Homebrew's toolchain");
    // The card's bar takes three columns; every line fits inside what is left.
    expect(narrow.every(l => l.length <= 48 - CARD_FRAME)).toBe(true);
    expect(summaryNote(FIXTURE, ticks, new Map(), 80)).toContain("Installs  Claude Code, 3 tools plus Homebrew's toolchain");
  });

  it("the card prints the pre-wrapped lines one for one, none past the columns, so nothing is wrapped twice", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/jq", "tools/npm/pnpm", "agents/claude"]);
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

describe("wsp init, everything else over a HOME on disk", () => {
  /** The collector over a HOME written to disk: the rows the screen shows are the real adapter's, not a fixture's. */
  async function found(home: string): Promise<Manifest> {
    const write = (rel: string, text: string): void => {
      const p = join(home, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    };
    const token = "e209b33186e466c19f1e7a229ab12345";
    write(`.mcp-auth/mcp-remote-0.1/${token}_tokens.json`, '{"access_token":"fake-token-value-long-enough"}');
    write(`.mcp-auth/mcp-remote-0.1/${token}_client_info.json`, '{"client_secret":"fake-secret-value-long-enough"}');
    write("Library/Application Support/Arc/StorableSidebar.json", "x".repeat(4_000));
    for (const cache of ["Cache", "Code Cache", "GPUCache"]) write(`Library/Application Support/Arc/User Data/Default/${cache}/data_0`, "c".repeat(100));
    write("Library/Application Support/com.docker.install/data.bin", "y".repeat(2_000));
    write("Library/Application Support/lazydocker/config.yml", "gui: {}\n");
    write(".config/mystery/thing.toml", "z = 1\n");
    write(".hermes/config.yaml", "model: x\n");
    write(".hermes/sessions/a/s.jsonl", "p".repeat(300));
    write(".hermes/file-history/x", "f".repeat(200));
    const machine: Machine = { platform: "darwin", home, path: [], env: {}, fs: nodeMachineFs, exec: { which: async () => false, run: async () => undefined } };
    const rows = (await everything(machine, { lookup: () => [], tools: ["lazydocker"], claimed: claimedPaths(FIXTURE.entries), now: Date.UTC(2026, 8, 5) })).rows;
    return { entries: [...FIXTURE.entries, ...entriesFor(rows)] };
  }

  it("rows sit under their parent, macOS app data is one folded group with its size, and no two rows read alike", async () => {
    const f = fake({ collect: async () => found(f.opts.home), columns: 80 });
    Object.assign(f.io.output, { rows: 60 });
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Everything else (");
    const screen = () => f.text().slice(f.text().lastIndexOf("Everything else ("));
    expect(screen()).toMatch(/▾ \.hermes\s+0 of 2 {2}509 B\n/);
    expect(screen()).toMatch(/○ \.hermes\s+9 B\s+unknown\n/);
    // The carve's label names its directory; the subtrees it holds are on the detail line, so no cut can lose the directory.
    expect(screen()).toMatch(/○ state files in ~\/\.hermes\s+500 B\s+state\n/);
    expect(screen()).toMatch(/▾ \.mcp-auth\s+2 {2}96 B\n/);
    expect(screen()).toMatch(/▾ ~\/\.config\s+0 of 1\s+6 B\n/);
    expect(screen()).toMatch(/○ mystery\s+6 B\s+unknown\n/);
    expect(screen()).toMatch(/▾ ~\/Library\/Application Support\s+0 of 1\s+8 B\n/);
    expect(screen()).toMatch(/○ lazydocker\s+8 B\s+config\n/);
    expect(screen()).toMatch(new RegExp(`▸ ${APP_DATA_GROUP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+0 of 3 {2}6\\.2 KB\n`));
    expect(screen()).not.toContain("Arc");
    expect(screen()).not.toContain("com.docker.install");
    const labels = screen().split("\n").filter(l => /[●○]/.test(l)).map(l => l.replace(/^.*[●○] /, "").replace(/ {2}.*$/, ""));
    expect(new Set(labels).size).toBe(labels.length);
    const mcp = labels.filter(l => l.startsWith(".mcp-auth/"));
    expect(mcp).toHaveLength(2);
    expect(mcp.every(l => l.includes("…") && l.endsWith(".json"))).toBe(true);
    // The all row leaves app data alone: the four plain rows tick, Arc and the Docker data do not.
    await f.press(KEY.space);
    expect(screen()).toMatch(/Selected: \.hermes, state files/);
    expect(screen()).toContain("4 ticked");
    expect(screen()).not.toMatch(/Selected: .*Arc/);
    // Unfolded, every app data row carries its ~/Library parent, so Arc never stands alone.
    for (let i = 0; i < 20 && !/❯ ▸ macOS app data/.test(screen()); i += 1) await f.press(KEY.down);
    await f.press(KEY.right);
    expect(screen()).toMatch(/○ Application Support\/Arc\s+3\.9 KB\s+app-data\n/);
    expect(screen()).toMatch(/○ Application Support\/com\.docker\.install\s+2\.0 KB\s+app-data\n/);
    // Arc's cache subtrees are one carve named for its directory, under the same group; the label is not a path, so no part of it goes dim.
    expect(screen()).toMatch(/○ cache files in ~\/L.*Support\/Arc\s+300 B\s+app-data\n/);
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    onTestFinished(() => {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    });
    f.clear();
    await f.press(KEY.down);
    expect(f.raw()).toContain("\x1b[2mApplication Support/\x1b[22mArc");
    f.clear();
    await f.press(KEY.down, KEY.down);
    expect(f.raw()).toMatch(/❯\x1b\[39m {3}\x1b\[2m○\x1b\[22m cache files in ~\/L/);
    expect(f.raw()).not.toContain("\x1b[2mcache files in ~/\x1b[22m");
    await f.press(KEY.esc);
    await f.until("Sign-ins");
    await f.press(KEY.ctrlC);
    await run;
  });
});

describe("everythingItems", () => {
  it("a row that was never measured says so in the size cell instead of leaving it blank", () => {
    const cache = { rung: "everything" as const, id: "everything/.cache", label: ".cache", paths: ["~/.cache"], bytes: 0, default: "skip" as const, role: "cache" as const, files: 0, mtime: 0, detail: "cache, rebuilt on use; not measured" };
    const demo = EVERYTHING[0]!;
    const [c, d] = everythingItems([cache, demo]);
    for (const width of [80, 100]) {
      expect(c!.hintFor!(width)).toMatch(/^\s*not measured\s+cache\s*$/);
      expect(d!.hintFor!(width)).toMatch(/^\s*300 B/);
      expect(c!.hintFor!(width).length).toBe(d!.hintFor!(width).length);
    }
  });

  it("only a path-shaped app data label carries its ~/Library parent as the dim prefix", () => {
    const arc = { rung: "everything" as const, id: "everything/Library/Application Support/Arc", label: "Application Support/Arc", group: APP_DATA_GROUP, paths: ["~/Library/Application Support/Arc"], bytes: 4_000, default: "skip" as const, role: "app-data" as const, files: 1, mtime: 0 };
    const caches = ["Cache", "Code Cache", "GPUCache"].map(c => `~/Library/Application Support/Arc/User Data/Default/${c}`);
    const carve = { ...arc, id: "everything/Library/Application Support/Arc/User Data/Default/Cache", label: "cache files in ~/Library/Application Support/Arc", paths: caches, bytes: 300, files: 3 };
    const [a, c] = everythingItems([arc, carve]);
    expect(a!.prefix).toBe("Application Support/");
    expect(c!.prefix).toBeUndefined();
  });
});

describe("fmtBytes", () => {
  it("steps through B, KB, MB and GB", () => {
    expect([12, 2_048, 3 * 1024 * 1024, 32_000_000_000].map(fmtBytes)).toEqual(["12 B", "2.0 KB", "3.0 MB", "29.8 GB"]);
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
      ["Installing the base (Node, the daemon)", "Base installed"],
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
    expect(long).toMatch(/x…  1m 01s$/);
    expect(stripVTControlCharacters(stageLine("o", "Ready", undefined, undefined, 60, 20))).toBe("o  Ready");
    // Off a terminal there is no width: nothing is cut and the duration follows two spaces after the detail.
    expect(stripVTControlCharacters(stageLine("o", "Base installed", "x".repeat(80), 61_000, undefined, 20))).toBe(`o  Base installed        ${"x".repeat(80)}  1m 01s`);
  });

  it("frames for another golden are ignored", () => {
    const view = reduceStages([{ type: "golden.stage" as const, name: "nightly", stage: "ready" }]);
    expect(view.steps).toEqual([]);
  });
});

describe("pack size before the boot", () => {
  it("a recipe whose files would not fit the machine's disk is refused after the summary, before anything boots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    // Under the disk estimate's room, over what the upload stage can hold twice (the archive and its files).
    const big = 9 * 1024 * 1024 * 1024;
    writeFileSync(path, JSON.stringify({ entries: FIXTURE.entries.map(e => ({ ...e, ...(e.id === "shell/zshrc" ? { bytes: big } : {}), bring: e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    const f = fake({ yes: true, manifestPath: path });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toMatch(/Upload\s+9\.0 GB, over the 8\.5 GB the machine's disk allows/);
    expect(out).not.toContain("This recipe needs about");
    expect(out).toContain("Recipe saved to");
    expect(out).toContain("Nothing was booted.");
    // Off a terminal there are no screens to untick on; the fix is the recipe file, named.
    expect(out).toContain(`Set bring to false on the larger rows in ${recipePath(f.opts.statePath)}`);
    expect(out).toContain(`wsp init --yes --manifest ${recipePath(f.opts.statePath)}`);
    expect(out).not.toContain("each screen shows sizes");
    expect(out).not.toMatch(BOOT);
    expect(f.backends[0]?.machines ?? []).toHaveLength(0);
    expect(f.hosts).toBe(0);
  });
});

describe("disk estimate before the boot", () => {
  const HUGE_GH = new Map([["gh", { name: "gh", fullName: "gh", deps: [], bytes: 30 * 1024 * 1024 * 1024, macosOnly: false }]]);

  /** The fixture as a saved recipe with every default tick written in: a formula this heavy starts unticked, so only a saved tick puts it in the plan. */
  const savedFixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: FIXTURE.entries.map(e => ({ ...e, bring: e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    return path;
  };
  const TOO_FULL = "Too full to build. Untick tools you do not need on the machine until the estimate leaves the red; keep headroom for what the build installs.";

  it("under --yes a recipe past the builder's disk is refused after the summary with the screens' sentence, before anything boots", async () => {
    const f = fake({ yes: true, manifestPath: savedFixture(), brew: async () => HUGE_GH });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toContain("Reading Homebrew for sizes");
    expect(out.replace(/\n\s*│?\s+/g, " ")).toMatch(/Disk\s+31\.3 GB, 16\.2 GB over the 15\.2 GB the 20 GB builder leaves/);
    expect(out).toContain(`${TOO_FULL} This recipe needs about 31.3 GB on the machine, 207 percent of the 15.2 GB the 20 GB builder leaves.`);
    expect(out).toContain("Recipe saved to");
    expect(out).toContain(`Nothing was booted. Set bring to false on rows in ${recipePath(f.opts.statePath)} until the estimate is under 11.4 GB, then run wsp init --yes --manifest ${recipePath(f.opts.statePath)}; the recipe is kept.`);
    expect(out).not.toMatch(BOOT);
    expect(f.backends[0]?.machines ?? []).toHaveLength(0);
    expect(f.hosts).toBe(0);
  });

  it("under --yes the line is the screens' own: a saved recipe at exactly 75.0 percent is refused, one byte under it proceeds to the boot", async () => {
    const MB = 1024 * 1024;
    // The room is 15,522 MB and the toolchain 1,024, so 10,617.5 MB more lands on 75 percent exactly; nothing else travels.
    const brew: BrewTable = new Map([
      ["over", { name: "over", fullName: "over", deps: [], bytes: 10_617.5 * MB, macosOnly: false }],
      ["edge", { name: "edge", fullName: "edge", deps: [], bytes: 10_617.5 * MB - 1, macosOnly: false }],
    ]);
    const saved = (ticked: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
      dirs.push(dir);
      const path = join(dir, "recipe.json");
      const rows = ["over", "edge"].map(name => ({ rung: "tools", id: `tools/brew/${name}`, label: name, group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes", bring: name === ticked }));
      writeFileSync(path, JSON.stringify({ entries: rows }));
      return path;
    };
    const refused = fake({ yes: true, manifestPath: saved("over"), brew: async () => brew });
    expect((await runInit(refused.opts, refused.io)).code).toBe(1);
    expect(refused.text()).toContain(`${TOO_FULL} This recipe needs about 11.4 GB on the machine, 75 percent of the 15.2 GB the 20 GB builder leaves.`);
    expect(refused.text()).not.toMatch(BOOT);
    const under = fake({ yes: true, manifestPath: saved("edge"), brew: async () => brew });
    const run = runInit(under.opts, under.io);
    await under.until(BOOT);
    expect(under.text()).not.toContain("Too full to build");
    await under.press(KEY.ctrlC);
    await run;
  });

  it("under --yes the refusal sits on the screens' 75 percent line, not at the room: a recipe at 88 percent is refused with a non-zero exit", async () => {
    const brew = new Map([["gh", { name: "gh", fullName: "gh", deps: [], bytes: 12 * 1024 * 1024 * 1024, macosOnly: false }]]);
    const f = fake({ yes: true, manifestPath: savedFixture(), brew: async () => brew });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    // The toolchain, gh, Claude Code and the two unmeasured rows: 13,670 MB of 15,522, under the room and past the line.
    expect(out.replace(/\n\s*│?\s+/g, " ")).toMatch(/Disk\s+13\.3 GB of 15\.2 GB on the 20 GB builder/);
    expect(out).toContain(`${TOO_FULL} This recipe needs about 13.3 GB on the machine, 88 percent of the 15.2 GB the 20 GB builder leaves.`);
    expect(out).toContain("Nothing was booted. Set bring to false on rows in");
    expect(out).not.toMatch(BOOT);
    expect(f.backends[0]?.machines ?? []).toHaveLength(0);
  });

  it("under --yes a formula of 500 MB and over is left out by the weight policy, so the same Homebrew fits the builder", async () => {
    const f = fake({ yes: true, brew: async () => HUGE_GH });
    const run = runInit(f.opts, f.io);
    await f.until(BOOT);
    const out = f.text();
    expect(out).toMatch(/Tools\s+2 of 4/);
    expect(out).not.toContain("over the 15.2 GB");
    expect(out).not.toContain("This recipe needs about");
    await f.press(KEY.ctrlC);
    await run;
  });

  it("the first install of a release tag records the tag and the asset's checksum into the recipe file; a pin from an older tag is replaced, not enforced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    const tap: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "unknown", pin: { tag: "v0.0.9", sha256: "9".repeat(64) } };
    writeFileSync(path, JSON.stringify({ entries: [...FIXTURE.entries, tap].map(e => ({ ...e, bring: e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    const brew = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * 1024 * 1024, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const sha = "b".repeat(64);
    const f = fake({ yes: true, manifestPath: path, brew: async () => brew });
    // A guest whose road install answers with the asset's checksum and the tag it fetched.
    const roadRuntime = (g: Fake) => (recipe: GoldenRecipe) => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("releases/tags/v0.1.0") ? { exitCode: 0, stdout: `WSP_ROAD release diskbloom_0.1.0_linux_amd64.tar.gz ${sha} v0.1.0\n`, stderr: "" } : guestAnswer(cmd));
      g.backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      g.runtimes.push(rt);
      return rt;
    };
    f.opts.runtime = roadRuntime(f);
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.text()).toContain("new release, checksum recorded");
    // The road command ran without a check: the recorded pin was for v0.0.9 and the tap now names v0.1.0.
    const road = f.backends[0]!.machines[0]!.execLog.find(c => c.includes("releases/tags/v0.1.0"))!;
    expect(road).not.toContain('[ "$sum" =');
    const saved = loadManifest(recipePath(f.opts.statePath));
    expect(saved.entries.find(e => e.id === "tools/brew/zingzy/tap/diskbloom")?.pin).toEqual({ tag: "v0.1.0", sha256: sha });
    expect(saved.entries.filter(e => e.pin !== undefined)).toHaveLength(1);
    // The results file carries the same checksum and tag beside the road.
    const results = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { tools: { id: string; road?: { kind: string; sha256?: string } }[] };
    expect(results.tools.find(t => t.id === "tools/brew/zingzy/tap/diskbloom")?.road).toEqual({ kind: "release", from: "diskbloom_0.1.0_linux_amd64.tar.gz", sha256: sha, tag: "v0.1.0" });
    // The same recipe again: the pin now matches the tag, so the road checks it and the summary says so.
    const again = fake({ yes: true, manifestPath: recipePath(f.opts.statePath), brew: async () => brew });
    again.opts.runtime = roadRuntime(again);
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toContain("checksum checked against the first install");
    const checked = again.backends[0]!.machines[0]!.execLog.find(c => c.includes("releases/tags/v0.1.0"))!;
    expect(checked).toContain(sha);
    expect(checked).toContain("does not match the checksum recorded on the first install of");
  });

  it("the tally after the build names every skipped tool with its reason, under the counts, and the results file carries the same rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    const unknown: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "unknown" };
    const cli: ManifestEntry = { rung: "tools", id: "tools/cli/ngrok", label: "ngrok", group: "Command-line tools", paths: [], bytes: 0, default: "bring", linux: "unknown" };
    writeFileSync(path, JSON.stringify({ entries: [...FIXTURE.entries, unknown, cli].map(e => ({ ...e, bring: e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    const f = fake({ yes: true, manifestPath: path, brew: async () => new Map() });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const tally = f.text().slice(f.text().indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 3).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 9 installed, 0 failed, 2 skipped; the list is in .*golden-import\.json$/),
      "diskbloom skipped: no Linux bottle known",
      "ngrok skipped: no GitHub release to install from",
    ]);
    const results = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { tools: { id: string; label: string; outcome: string; note?: string }[] };
    expect(results.tools.filter(t => t.outcome === "skipped")).toEqual([
      { id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", outcome: "skipped", note: "no Linux bottle known" },
      { id: "tools/cli/ngrok", label: "ngrok", outcome: "skipped", note: "no GitHub release to install from" },
    ]);
  });

  it("a Homebrew that cannot be read is a note, not a stop; the summary falls back to the measured table", async () => {
    const f = fake({ yes: true, brew: async () => { throw new Error("brew: command timed out"); } });
    const run = runInit(f.opts, f.io);
    await f.until(BOOT);
    expect(f.text()).toContain("Homebrew could not be read for sizes (brew: command timed out); formula sizes come from the measured table alone.");
    expect(f.text()).toMatch(/Disk\s+1\.4 GB of 15\.2 GB/);
    await run;
  });

  it("the Tools screen puts a size beside every tick, Homebrew's toolchain at the top of its group, and the running total at the bottom; the Agents screen shows install sizes", async () => {
    const brew = new Map([
      ["gh", { name: "gh", fullName: "gh", deps: [], bytes: 50 * 1024 * 1024, macosOnly: false }],
      ["jq", { name: "jq", fullName: "jq", deps: ["oniguruma"], bytes: 2 * 1024 * 1024, macosOnly: false }],
      ["oniguruma", { name: "oniguruma", fullName: "oniguruma", deps: [], bytes: 1024 * 1024, macosOnly: false }],
    ]);
    const f = fake({ brew: async () => brew, columns: 120 });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    for (const rung of ["Shell", "Editors", "Toolchains", "Tools"]) {
      await f.press(KEY.enter);
      await f.until(rung);
    }
    const screen = f.text().slice(f.text().lastIndexOf("Tools"));
    const rows = screen.split("\n");
    const at = (needle: RegExp) => rows.findIndex(l => needle.test(l));
    expect(at(/▾ Homebrew\s+2 of 2/)).toBeGreaterThan(-1);
    expect(at(/● Homebrew's toolchain \(glibc, gcc\)\s+1\.0 GB/)).toBe(at(/▾ Homebrew\s/) + 1);
    // The toolchain row also stands on a screen of taps alone, since a tap brings Homebrew.
    const tapsOnly = toolsItems([{ rung: "tools", id: "tools/brew-tap/zingzy/tap", label: "zingzy/tap", group: "Homebrew taps", paths: [], bytes: 0, default: "bring" }], new Map());
    expect(tapsOnly[0]!.id).toBe("tools/homebrew-toolchain");
    expect(tapsOnly[0]!.follows!(new Set(["tools/brew-tap/zingzy/tap"]))).toBe(true);
    expect(tapsOnly[0]!.follows!(new Set())).toBe(false);
    expect(screen).toMatch(/● gh\s+50\.0 MB/);
    expect(screen).toMatch(/● jq\s+3\.0 MB/);
    // A row nothing measured shows its kind's default behind a tilde.
    expect(screen).toMatch(/● pnpm\s+~50\.0 MB/);
    expect(screen).toMatch(/○ rectangle\s+stays here/);
    // Files from the earlier screens, the toolchain and the two formulae so far; pnpm has no size.
    expect(screen).toMatch(/files 1[\d.]+ KB, Homebrew's toolchain 1\.0 GB, tools 53\.0 MB; 1 unmeasured, ~50\.0 MB\n┃\n┃  Disk: 1\.1 GB of 15\.2 GB on the 20 GB builder\n┗/);
    // Past the group header, the toolchain row and gh onto jq; its detail names the closure and where the number came from.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
    expect(f.text()).toContain("about 3.0 MB with 1 dependency, from this Mac's Homebrew; brought by default");
    // Unticking jq drops its closure from the total.
    await f.press(KEY.space);
    expect(f.text().split("\n").filter(l => l.includes("Homebrew's toolchain 1.0 GB, tools")).at(-1)).toMatch(/tools 50\.0 MB/);
    await f.press(KEY.enter);
    await f.until("Agents");
    // Onto Claude Code, whose detail names what installs and what travels.
    await f.press(KEY.down);
    const agents = f.text().slice(f.text().lastIndexOf("Agents"));
    expect(agents).toMatch(/● Claude Code\s+208\.0 MB/);
    expect(agents).toMatch(/○ Codex\s+455\.0 MB/);
    // An agent nobody measured says so rather than showing its config size in the install column.
    const aider = selectItem({ rung: "agents", id: "agents/aider", label: "Aider", paths: ["~/.aider.conf.yml"], bytes: 900, default: "skip" });
    expect(aider.hint).toBe("~350.0 MB");
    expect(aider.detail[1]).toBe("installs on the machine (not measured, ~350.0 MB assumed for an agent); its config (900 B) comes along");
    const zed = selectItem({ rung: "agents", id: "agents/zed", label: "Zed", paths: ["~/.config/zed"], bytes: 900, default: "skip" });
    expect(zed.hint).toBe("900 B");
    // A command cask's row names its release and the go fallback it carries, and counts at the go default for that fallback's
    // caches; one without a fallback counts at the install default, and one whose stanza had no Linux block waits for a tick.
    const spoo = selectItem({ rung: "tools", id: "tools/cli/spoo", label: "spoo", paths: ["github.com/spoo-me/spoo-cli@v0.4.1", "github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0"], bytes: 0, default: "bring", linux: "yes", version: "0.4.1" });
    expect(spoo.hint).toBe("~500.0 MB");
    expect(spoo.detail).toEqual(["github.com/spoo-me/spoo-cli@v0.4.1, github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0", "its Linux release binary, else go install of the module; not measured, ~500.0 MB assumed for a go install since the fallback fills go's caches; checksum recorded on first install; brought by default"]);
    const maybe = selectItem({ rung: "tools", id: "tools/cli/ngrok", label: "ngrok", paths: ["github.com/ngrok/ngrok@v3"], bytes: 0, default: "skip", linux: "unknown", version: "3" });
    expect(maybe.hint).toBe("~100.0 MB");
    expect(maybe.detail[1]).toBe("Linux build unknown, tick to try; its Linux release binary; not measured, ~100.0 MB assumed for an install; checksum recorded on first install; left out by default");
    // The terminal font row copies nothing and installs nothing: its detail says what the tick does instead.
    const font = selectItem({ rung: "shell", id: "shell/terminal-font", label: "terminal font: Hack (Ghostty)", paths: [], bytes: 0, default: "bring", font: "Hack" });
    expect(font.hint).toBeUndefined();
    expect(font.detail).toEqual(["read from your terminal's config; nothing to copy", "the app's terminal draws with it when this computer has it installed; unticked, the app uses its own font"]);
    expect(agents).toContain("installs about 208.0 MB on the machine (measured 2026-09-05); its config (39.1 KB) comes along");
    // The parts line takes the second slot when it runs past the width, so the marker is not cut off.
    expect(agents).toMatch(/files [\d.]+ KB, Homebrew's toolchain 1\.0 GB, tools 50\.0 MB, agents 208\.0 MB; 1 unmeasured,(?:\n┃  | )~50\.0(?:\n┃  | )MB\n┃  Disk: 1\.3 GB of 15\.2 GB on the 20 GB builder\n┗/);
    await f.press(KEY.ctrlC);
    await run;
  });

  it("the Tools screen colours sizes by weight, starts a heavy formula and an unknown Linux build unticked with the reason in the detail pane, and turns the Disk line as the total nears the room", async () => {
    const MB = 1024 * 1024;
    const formula = (name: string, mib: number): [string, BrewFormula] => [name, { name, fullName: name, deps: [], bytes: mib * MB, macosOnly: false }];
    const brew: BrewTable = new Map([formula("gh", 250), formula("big", 600), formula("huge", 8_500), formula("mas", 300)]);
    const tools: ManifestEntry[] = [
      { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/big", label: "big", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/huge", label: "huge", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" },
      { rung: "tools", id: "tools/brew/mas", label: "mas", group: "Homebrew", paths: [], bytes: 0, default: "skip", reason: "no Linux bottle", linux: "no" },
    ];
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    try {
      const f = fake({ brew: async () => brew, collect: async () => ({ entries: tools }), columns: 120 });
      const run = runInit(f.opts, f.io);
      await f.until("Tools");
      const frame = () => f.raw().slice(f.raw().lastIndexOf("\x1b[36m◆\x1b[39m  \x1b[36mTools"));
      // The size column alone takes the colour, right-aligned as before; the labels stay dim like every other row.
      expect(frame()).toMatch(/\x1b\[31m\s*1\.0 GB\x1b\[39m/);
      expect(frame()).toMatch(/\x1b\[2mgh\s*\x1b\[22m  \x1b\[33m\s*250\.0 MB\x1b\[39m/);
      expect(frame()).toMatch(/\x1b\[2mbig\s*\x1b\[22m  \x1b\[93m\s*600\.0 MB\x1b\[39m/);
      expect(frame()).toMatch(/\x1b\[2mhuge\s*\x1b\[22m  \x1b\[31m\s*8\.3 GB\x1b\[39m/);
      // A row nothing measured shows its default behind a tilde, weighed like a measured 100 MB; a row locked out has no weight, whatever its Mac size.
      expect(frame()).toMatch(/diskbloom\s*\x1b\[22m  \x1b\[2m\s*~100\.0 MB\x1b\[22m/);
      expect(frame()).toMatch(/\x1b\[2mmas\s*\x1b\[22m  \x1b\[2m\s*stays here\x1b\[22m/);
      const screen = () => f.text().slice(f.text().lastIndexOf("◆  Tools"));
      expect(screen()).toMatch(/● gh\s+250\.0 MB/);
      expect(screen()).toMatch(/○ big\s+600\.0 MB/);
      expect(screen()).toMatch(/○ huge\s+8\.3 GB/);
      expect(screen()).toMatch(/○ zingzy\/tap\/diskbloom\s+~100\.0 MB/);
      expect(screen()).toMatch(/▾ Homebrew\s+1 of 4/);
      // Under 50 percent the Disk line is loud but plain, with the dim parts line above it and the keys right under.
      expect(frame()).toMatch(/\x1b\[2mHomebrew's toolchain 1\.0 GB, tools 250\.0 MB\x1b\[22m\n\x1b\[2m┃\x1b\[22m\n\x1b\[2m┃\x1b\[22m  Disk: 1\.2 GB of 15\.2 GB on the 20 GB builder\n\x1b\[2m┗/);
      // Onto big: its detail line reads in normal text and names the weight as the reason it starts unticked.
      await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
      expect(frame()).toContain("\x1b[22m  600.0 MB, tick to bring; from this Mac's Homebrew\n");
      await f.press(KEY.space);
      await f.press(KEY.down);
      expect(frame()).toContain("\x1b[22m  8.3 GB, tick to bring; from this Mac's Homebrew\n");
      await f.press(KEY.space);
      // The toolchain, gh, big and huge: 10,374 MB of 15,522, past 65 percent.
      expect(frame()).toMatch(/\x1b\[93mDisk: 10\.1 GB of 15\.2 GB on the 20 GB builder\x1b\[39m\n\x1b\[2m┗/);
      // Without big the total sits between 50 and 65 percent.
      await f.press(KEY.up, KEY.space);
      expect(frame()).toMatch(/\x1b\[33mDisk: 9\.5 GB of 15\.2 GB on the 20 GB builder\x1b\[39m\n\x1b\[2m┗/);
      // The unknown build says why it waits for a tick, that nothing sized it, and what it counts as.
      await f.press(KEY.down, KEY.down);
      expect(frame()).toContain("\x1b[22m  Linux build unknown, tick to try; not measured, ~100.0 MB assumed for an install\n");
      await f.press(KEY.ctrlC);
      await run;
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("at 75 percent of the room the Tools screen holds Enter, the two footer slots say what to do and the Disk line is red; one byte under, Enter advances", async () => {
    const MB = 1024 * 1024;
    // The room is 15,522 MB and the toolchain 1,024, so 10,617.5 MB more lands on 75 percent exactly.
    const brew: BrewTable = new Map([
      ["over", { name: "over", fullName: "over", deps: [], bytes: 10_617.5 * MB, macosOnly: false }],
      ["edge", { name: "edge", fullName: "edge", deps: [], bytes: 10_617.5 * MB - 1, macosOnly: false }],
    ]);
    const tools: ManifestEntry[] = [
      { rung: "tools", id: "tools/brew/over", label: "over", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/edge", label: "edge", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
    ];
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    try {
      const f = fake({ brew: async () => brew, collect: async () => ({ entries: tools }), columns: 120 });
      const run = runInit(f.opts, f.io);
      await f.until("Tools");
      const frame = () => f.raw().slice(f.raw().lastIndexOf("\x1b[36m◆\x1b[39m  \x1b[36mTools"));
      const bar = "\x1b[2m┃\x1b[22m";
      // Down past the header and the toolchain onto over; ticking it lands on the line.
      await f.press(KEY.down, KEY.down, KEY.down, KEY.space);
      // At 100 columns the message wraps over the two slots that hold the parts and an empty line otherwise.
      expect(frame()).toContain(`${bar}  \x1b[2mSelected: over\x1b[22m\n${bar}  Too full to build. Untick tools you do not need on the machine until the estimate leaves the\n${bar}  red; keep headroom for what the build installs.\n${bar}  \x1b[31mDisk: 11.4 GB of 15.2 GB on the 20 GB builder\x1b[39m\n\x1b[2m┗`);
      await f.press(KEY.enter);
      expect(f.text()).not.toContain("◆  Agents");
      expect(frame()).toContain("Too full to build.");
      // Off the line by a byte: the slot shows the parts again, the line is bright yellow, and Enter goes on.
      await f.press(KEY.space, KEY.down, KEY.space);
      expect(frame()).toContain(`${bar}  \x1b[2mSelected: edge\x1b[22m\n${bar}  \x1b[2mHomebrew's toolchain 1.0 GB, tools 10.4 GB\x1b[22m\n${bar}\n${bar}  \x1b[93mDisk: 11.4 GB of 15.2 GB on the 20 GB builder\x1b[39m\n\x1b[2m┗`);
      await f.press(KEY.enter);
      // Nothing else on this laptop, so the run goes straight to the boot question.
      await f.until(BOOT);
      await f.press(KEY.ctrlC);
      await run;
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("at 60, 76 and 80 columns the held sentence lands whole over as many slots as it wraps to, and the slots stay put when the hold lifts", async () => {
    const MB = 1024 * 1024;
    const brew: BrewTable = new Map([
      ["over", { name: "over", fullName: "over", deps: [], bytes: 10_617.5 * MB, macosOnly: false }],
      ["edge", { name: "edge", fullName: "edge", deps: [], bytes: 10_617.5 * MB - 1, macosOnly: false }],
    ]);
    const tools: ManifestEntry[] = [
      { rung: "tools", id: "tools/brew/over", label: "over", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/edge", label: "edge", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
    ];
    // The sentence takes three lines under 76 columns and two from there up to the 100 column cap.
    for (const [columns, slots] of [[60, 3], [76, 2], [80, 2]] as const) {
      const f = fake({ brew: async () => brew, collect: async () => ({ entries: tools }), columns });
      const run = runInit(f.opts, f.io);
      await f.until("Tools");
      // The last redraw's footer: the lines from its Selected line to its Disk line, the bar taken off.
      const between = (): string[] => {
        const lines = f.text().slice(f.text().lastIndexOf("┃  Selected:")).split("\n");
        return lines.slice(1, lines.findIndex(l => l.startsWith("┃  Disk:"))).map(l => l.replace(/^┃ {0,2}/, ""));
      };
      // Down past the header and the toolchain onto over; ticking it lands on the line.
      await f.press(KEY.down, KEY.down, KEY.down, KEY.space);
      const held = between();
      expect(held, `${columns} columns`).toHaveLength(slots);
      expect(held.join(" "), `${columns} columns`).toBe(TOO_FULL);
      expect(held.every(l => l.length <= columns - 4), `${columns} columns`).toBe(true);
      // Off the line by a byte: the parts take the first slot and the rest stay empty, the same count.
      await f.press(KEY.space, KEY.down, KEY.space);
      const free = between();
      expect(free, `${columns} columns`).toHaveLength(slots);
      expect(free[0], `${columns} columns`).toBe("Homebrew's toolchain 1.0 GB, tools 10.4 GB");
      expect(free.slice(1), `${columns} columns`).toEqual(Array<string>(slots - 1).fill(""));
      await f.press(KEY.ctrlC);
      await run;
    }
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
      const f = fake({ yes: true, home: first.opts.home, ...o });
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
    expect(await store.get("goldens", "default")).toMatchObject({ head: 2 });
    // The update kept the golden's disk, so what v1's sign-in stage recorded (both skipped under --yes) is stamped on v2 as it was.
    const skipped = [{ name: "GitHub CLI login", state: "skipped" }, { name: "Claude Code login", state: "skipped" }];
    expect(((await store.get("goldens", "default")) as { versions: { logins?: unknown }[] }).versions.map(v => v.logins)).toEqual([skipped, skipped]);
    expect(await store.get("golden-recipes", "default@v2")).toBeDefined();
    // The saved recipe is the new one, and a run on it finds nothing to update.
    const again = next({ tty: false, manifestPath: recipePath(f.opts.statePath) });
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toContain("Golden v2 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(shared.machines).toHaveLength(3);
  });

  it("a binary row unticked after the seal comes off on the update, and the tally names what was removed", async () => {
    const { store, shared, first, next } = await sealed();
    const saved = JSON.parse(readFileSync(recipePath(first.opts.statePath), "utf8")) as { entries: ManifestEntry[] };
    const path = join(dirname(first.opts.statePath), "recipe-without-nvim.json");
    writeFileSync(path, JSON.stringify({ entries: saved.entries.map(e => (e.id === "editors/nvim" ? { ...e, bring: false } : e)) }));
    const f = next({ tty: false, manifestPath: path });
    const builder = shared.machines[0]!;
    const before = builder.execLog.length;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("remove 1 editor: neovim");
    expect(out).toContain("Small change: update on the builder kept since the save");
    const ran = builder.execLog.slice(before);
    expect(ran.filter(c => c.includes("apt-get purge -y -qq neovim && apt-get autoremove -y -qq --purge"))).toHaveLength(1);
    expect(ran.some(c => c.includes("apt-get install"))).toBe(false);
    expect(out).toMatch(/Golden v2 sealed in \d+s on the builder kept since the save/);
    // The fixture home has no nvim config, so the binary is the one thing that comes off.
    expect(out).toMatch(/Tools, agents and machine context: 0 installed, 1 removed, 0 failed, 0 skipped; the list is in .*golden-import\.json/);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({ tools: [], removed: [{ what: "editor", id: "editors/nvim", label: "neovim", outcome: "removed" }] });
    expect(await store.get("goldens", "default")).toMatchObject({ head: 2 });
  });

  it("the tally counts tools, editors and agents removed, says how many were not, and leaves an update's file removals to the saved list", async () => {
    const { shared, first, next } = await sealed();
    const saved = JSON.parse(readFileSync(recipePath(first.opts.statePath), "utf8")) as { entries: ManifestEntry[] };
    const path = join(dirname(first.opts.statePath), "recipe-less.json");
    writeFileSync(path, JSON.stringify({ entries: saved.entries.map(e => (e.id === "editors/nvim" || e.id === "shell/zshrc" ? { ...e, bring: false } : e)) }));
    shared.execImpl = (_m, cmd) => (cmd.includes("apt-get purge -y -qq neovim") ? { exitCode: 100, stdout: "", stderr: "E: Could not get lock /var/lib/dpkg/lock-frontend" } : guestAnswer(cmd));
    const f = next({ tty: false, manifestPath: path });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("remove 1 file: ~/.zshrc");
    expect(out).toContain("remove 1 editor: neovim");
    const tally = out.slice(out.indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇●]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 0 installed, 0 removed, 0 failed, 1 not removed, 0 skipped; the list is in .*golden-import\.json$/),
      "neovim not removed: E: Could not get lock /var/lib/dpkg/lock-frontend",
    ]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      removed: [
        { what: "file", id: "shell/zshrc", outcome: "removed" },
        { what: "editor", id: "editors/nvim", outcome: "failed", note: "E: Could not get lock /var/lib/dpkg/lock-frontend" },
      ],
    });
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
    const { shared, first, next } = await sealed();
    const manifestPath = join(first.opts.home, "manifest.json");
    // gh answered as a sign-in in the file, so the terminal run and the --yes run below read the same recipe.
    writeFileSync(manifestPath, JSON.stringify({ entries: FIXTURE.entries.map(e => (e.id === "agents/codex" ? { ...e, bring: true } : e.id === "logins/gh" ? { ...e, choice: "machine" } : e)) }));
    // A rebuild with the new recipe whose seal was answered no: its builder stays, first-life, carrying the new hash.
    const rebuilt = next({ manifestPath, yes: false, tty: true });
    rebuilt.opts.host = quietHost();
    const run = runInit(rebuilt.opts, rebuilt.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await rebuilt.until(rung);
      await rebuilt.press(KEY.enter);
    }
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

    const again = next({ manifestPath, tty: false });
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
    const manifestPath = join(first.opts.home, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ entries: FIXTURE.entries.map(e => (e.id === "agents/codex" ? { ...e, bring: true } : e)) }));
    const third = next({ manifestPath, tty: false });
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

  it("--yes with a big change (an agent added) takes the rebuild: the boot question follows, the kept builder is no blocker, a fresh builder boots beside it, and its seal forks nothing beside the existing workspace", async () => {
    const { store, shared, first, next } = await sealed();
    // The person's one workspace, forked from v1 before the rebuild.
    const alpha = await createRuntime({ backend: shared, store, adapters: {} }).workspaces.create({ golden: "snap_golden-v1", name: "alpha" });
    const manifestPath = join(first.opts.home, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ entries: FIXTURE.entries.map(e => (e.id === "agents/codex" ? { ...e, bring: true } : e)) }));
    const f = next({ manifestPath });
    const hosted: string[] = [];
    f.opts.host = async (rt, builder) => {
      hosted.push(builder.id);
      return { port: 4400, wsPort: 4410, authToken: "tok", createWorkspace: name => forkHead(rt, name), close: async () => {} };
    };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("add 1 agent: Codex");
    expect(out).toContain("A big change: a rebuild from scratch is the safer road, about ten minutes.");
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
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("How do you want to apply them?");
    const asked = f.text();
    expect(asked).toContain("Update the golden (under a minute, about $0.11/hr while it runs)");
    expect(asked).toContain("Rebuild from scratch (about ten minutes)");
    expect(asked.indexOf("Update the golden")).toBeLessThan(asked.indexOf("Rebuild from scratch"));
    await f.press(KEY.enter);
    expect((await run).code).toBe(0);
    expect(f.text()).toMatch(/Golden v2 sealed in \d+s on the builder kept since the save/);
    expect(f.text()).not.toMatch(BOOT);
    expect(shared.machines).toHaveLength(3);
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

  it("a login flipped to sign in on the machine is not done by an update: the offer says it would not be in the golden and the rebuild is the default", async () => {
    const { shared, first, next } = await sealed();
    const manifestPath = join(first.opts.home, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ entries: FIXTURE.entries.map(e => (e.id === "logins/gh" ? { ...e, bring: true, choice: "machine" } : e)) }));
    const f = next({ manifestPath });
    const hosted: string[] = [];
    f.opts.host = async (_rt, builder) => {
      hosted.push(builder.id);
      return quietHost()();
    };
    const flipped = await runInit(f.opts, f.io);
    expect(flipped.code).toBe(0);
    const out = f.text();
    expect(out).toContain("GitHub CLI login: sign in on the machine is not done by an update");
    // The rebuild road ran the sign-in stage for the flipped login (skipped under --yes, but asked).
    expect(flipped.logins?.map(l => [l.id, l.state])).toContainEqual(["logins/gh", "skipped"]);
    expect(out).toContain("Rebuilding from scratch. Taken as the default (--yes).");
    expect(hosted).toEqual(["m3"]);
    expect(shared.machines[0]!.killed).toBe(true);
  });

  it("interactive: down then enter picks the rebuild, and the boot question follows", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
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

describe("wsp init, a login whose command is not coming", () => {
  /** gcloud-cli as the collector reads it: a command row, locked since Google's release is not on GitHub, with the Mac's version. */
  const GCLOUD_CASK: ManifestEntry = { rung: "tools", id: "tools/cli/gcloud", label: "gcloud (gcloud-cli)", group: "Command-line tools", paths: [], bytes: 0, default: "skip", reason: "command-line tool, but not from a GitHub release; no Linux install path", linux: "no", version: "575.0.0" };
  const GCLOUD_LOGIN: ManifestEntry = { rung: "logins", id: "logins/gcloud", label: "Google Cloud login", group: "CLI logins", paths: ["~/.config/gcloud/credentials.db"], bytes: 4000, default: "bring" };
  const WRANGLER_LOGIN: ManifestEntry = { rung: "logins", id: "logins/wrangler", label: "Cloudflare Wrangler login", group: "CLI logins", paths: ["~/Library/Preferences/.wrangler/config/default.toml"], bytes: 300, default: "bring" };
  const LAPTOP: Manifest = { entries: [...FIXTURE.entries.filter(e => e.rung !== "logins" || e.id === "logins/gh"), GCLOUD_CASK, GCLOUD_LOGIN, WRANGLER_LOGIN] };
  const savedRow = (id: string) => loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.find(e => e.id === id)!;
  /** A card's wrapped closing lines as one line each. */
  const unwrapped = (card: string): string => card.replace(/\n│ {12}/g, " ");

  it("the Tools screen offers the cask from Google's release; the Sign-ins screen says which commands are not coming, starts them at skip, names the cycle in its keys, and a copy answer ticks the cask", async () => {
    const f = fake({ collect: async () => LAPTOP });
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Tools");
    // Down to the casks: open to a tick, unticked, from Google's release, where an app cask is locked with "stays here".
    await f.press(...Array.from({ length: 10 }, () => KEY.down));
    await f.until(/○ gcloud \(gcloud-cli\)\s+Google's Linux release\n/);
    await f.until(/○ rectangle\s+stays here\n/);
    await f.until("from Google's Linux release, checksum recorded on first install");
    await f.press(KEY.enter);
    await f.until("Agents");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).toMatch(/GitHub CLI login\s+sign in\n/);
    expect(f.text()).toMatch(/Google Cloud login\s+gcloud not coming\s+skip\n/);
    expect(f.text()).toMatch(/Cloudflare Wrangler login\s+wrangler not coming\s+skip\n/);
    // Every row here is answered, so the keys name the cycle alone, not a tick nothing on the screen has.
    expect(f.text()).toContain("┗  space sign in, copy, skip • ← → fold • enter next • esc back");
    // Down past the heading and gh onto gcloud: the detail says why and what a copy does; space steps skip to sign in, then to copy.
    await f.press(KEY.down, KEY.down);
    await f.until("gcloud is not coming: its tool row is unticked; copy or sign in ticks it");
    await f.press(KEY.space);
    await f.until(/Google Cloud login\s+gcloud not coming\s+sign in/);
    await f.press(KEY.space);
    await f.until(/Google Cloud login\s+gcloud not coming\s+copy/);
    await f.press(KEY.down);
    await f.until("wrangler is not coming: no row lists it; npm install -g wrangler brings it");
    await f.press(KEY.enter);
    await f.until(BOOT);
    expect(f.text()).toContain("ticked under Tools for the sign-ins: gcloud (gcloud-cli)");
    const summary = f.text().slice(f.text().lastIndexOf("Summary"), f.text().lastIndexOf("Recipe saved"));
    expect(summary).toMatch(/Tools\s+4 of 5\n/);
    expect(summary).toMatch(/Google Cloud login\s+copy\n/);
    expect(summary).toMatch(/Cloudflare Wrangler login\s+skip\n/);
    expect(unwrapped(summary)).toContain("4 tools plus Homebrew's toolchain, gcloud (gcloud-cli) from Google's Linux release (checksum recorded on first install)");
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    expect(savedRow("tools/cli/gcloud")).toMatchObject({ bring: true, default: "skip", linux: "yes", version: "575.0.0" });
    expect(savedRow("tools/cli/gcloud").reason).toBeUndefined();
    expect(savedRow("logins/gcloud")).toMatchObject({ bring: true, choice: "copy" });
    expect(savedRow("logins/wrangler")).toMatchObject({ bring: false, choice: "skip" });
  });

  it("under --yes a fresh collection skips the logins whose commands are not coming and installs no cask for them", async () => {
    const f = fake({ yes: true, collect: async () => LAPTOP });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const summary = f.text().slice(f.text().indexOf("Summary"), f.text().indexOf("Recipe saved"));
    expect(summary).toMatch(/Google Cloud login\s+skip\n/);
    expect(summary).toMatch(/Cloudflare Wrangler login\s+skip\n/);
    expect(summary).not.toContain("gcloud (gcloud-cli) from");
    expect(savedRow("tools/cli/gcloud")).toMatchObject({ bring: false });
    expect(savedRow("logins/gcloud")).toMatchObject({ bring: false, choice: "skip" });
    // Neither login reached the sign-in stage, so neither is in the notes.
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).logins.map((l: { id: string }) => l.id)).not.toContain("logins/gcloud");
  });

  it("a saved recipe that copies the Google Cloud login with its cask unticked, as one run of his did, brings the cask with it under --yes", async () => {
    const f = fake({ yes: true });
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    f.opts.manifestPath = join(dir, "recipe.json");
    writeFileSync(f.opts.manifestPath, JSON.stringify({ entries: LAPTOP.entries.map(e => (e.id === "logins/gcloud" ? { ...e, bring: true, choice: "copy" } : e.id === "logins/wrangler" ? { ...e, bring: false, choice: "skip" } : { ...e, bring: e.default === "bring" })) }));
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("ticked under Tools for the sign-ins: gcloud (gcloud-cli)");
    const summary = f.text().slice(f.text().indexOf("Summary"), f.text().indexOf("Recipe saved"));
    expect(summary).toMatch(/Google Cloud login\s+copy\n/);
    expect(unwrapped(summary)).toContain("gcloud (gcloud-cli) from Google's Linux release (checksum recorded on first install)");
    expect(savedRow("tools/cli/gcloud")).toMatchObject({ bring: true });
    const tools = JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).tools as { id: string; outcome: string }[];
    expect(tools.find(t => t.id === "tools/cli/gcloud")).toMatchObject({ outcome: "installed" });
  });

  it("the card says a pinned kubectl is checked against the first install on the second run, whatever version Docker Desktop moved to", async () => {
    const f = fake({ yes: true });
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    f.opts.manifestPath = join(dir, "recipe.json");
    const docker: ManifestEntry = { rung: "tools", id: "tools/brew-cask/docker-desktop", label: "docker-desktop", group: "Homebrew casks", paths: [], bytes: 0, default: "skip", linux: "yes", version: "4.81.0,240001", pin: { tag: "v1.37.0", sha256: "c".repeat(64) }, bring: true };
    writeFileSync(f.opts.manifestPath, JSON.stringify({ entries: [...LAPTOP.entries.map(e => ({ ...e, bring: e.default === "bring" })), docker] }));
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const summary = f.text().slice(f.text().indexOf("Summary"), f.text().indexOf("Recipe saved"));
    expect(unwrapped(summary)).toContain("docker-desktop from Kubernetes release (checksum checked against the first install)");
  });
});

describe("shellItems", () => {
  const zshrc: ManifestEntry = { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 3000, default: "bring", aliases: [{ name: "ls", runs: "eza", kind: "alias", tool: "tools/brew/eza" }, { name: "cat", runs: "bat", kind: "alias", tool: "tools/brew/bat" }], sources: ["~/.cargo/env", "~/.config/starship.toml"] };
  const starship: ManifestEntry = { rung: "shell", id: "shell/starship", label: "starship prompt", paths: ["~/.config/starship.toml"], bytes: 900, default: "bring" };
  const eza: ManifestEntry = { rung: "tools", id: "tools/brew/eza", label: "eza", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "yes" };
  const bat: ManifestEntry = { rung: "tools", id: "tools/brew/bat", label: "bat", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" };

  it("a shell row's detail names the aliases whose tool starts unticked, after its own two lines; the tools screen's own ticks win once it was visited", () => {
    const fresh = shellItems([zshrc, starship], [zshrc, starship, eza, bat], undefined, new Map());
    expect(fresh[0]!.detail).toEqual(["~/.zshrc", "2.9 KB, brought by default", "alias ls points at eza, which is not coming (unticked, tick to bring)", "sources ~/.cargo/env, which nothing here brings; the machine skips that line"]);
    expect(fresh[1]!.detail).toEqual(["~/.config/starship.toml", "900 B, brought by default"]);
    const visited = shellItems([zshrc], [zshrc, starship, eza, bat], new Set(["tools/brew/eza"]), new Map());
    expect(visited[0]!.detail).toEqual(["~/.zshrc", "2.9 KB, brought by default", "alias cat points at bat, which is not coming (unticked, tick to bring)", "sources ~/.cargo/env, which nothing here brings; the machine skips that line"]);
  });

  it("a sourced file that a row carries is quiet while that row starts ticked and named once it starts unticked", () => {
    const skipped = { ...starship, default: "skip" as const };
    expect(shellItems([zshrc], [zshrc, skipped, eza, bat], new Set(["tools/brew/eza", "tools/brew/bat"]), new Map())[0]!.detail.at(-1)).toBe("sources ~/.config/starship.toml, which is not coming (starship prompt unticked, tick to bring); the machine skips that line");
  });
});
