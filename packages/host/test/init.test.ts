// SPDX-License-Identifier: AGPL-3.0-only
// wsp init end to end against the stub backend: keys in, the seven screens,
// the summary and confirm, prepare with its stage stream, the sign-ins and
// secrets, the seal, the first workspace and the app's address. The runtime
// and host are the real ones over fakes; only the terminal is faked.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { APP_DATA_GROUP, RUNGS, claimedPaths, entriesFor, everything, nodeMachineFs, type Machine, type Manifest, type ManifestEntry } from "@wsp/collect";
import { SNAPSHOT_STORAGE, type BackendPricing } from "@wsp/engine";
import { ALREADY_APPLIED } from "@wsp/protocol";
import { DAEMON_TOKEN_SET, createRuntime, memoryStore, type GoldenRecipe, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SETUP } from "../src/doctor.js";
import { loadManifest, recipePath } from "../src/init-recipe.js";
import { CARD_FRAME, card, widthOf } from "../src/init-layout.js";
import { editorsIntro, everythingItems, fmtBytes, reduceStages, runInit, selectItem, stageLine, summaryNote, toolsItems, type HostHooks, type InitIO, type InitOptions } from "../src/init.js";
import type { HostHandle } from "../src/server.js";
import { startCallbackRelay } from "../src/relay.js";
import type { ConnectOptions, DaemonSocket } from "../src/doctor.js";
import { appendCommand, readCommand } from "../src/init-secrets.js";
import { noteOutcomes } from "../src/init-signin.js";
import { fakePtyLink, type FakePtyLink } from "./fake-pty-link.js";
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

/** Ptys on the fake builder: a login prints its page's URL and exits (or waits for Ctrl-C when held); a status run answers as told. */
function scriptedLink(state: { signedIn: boolean; hold: boolean; missing: boolean }): FakePtyLink {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    if (state.missing && line.startsWith("exec ")) {
      link.data(pty, `bash: exec: ${line.split(" ")[1]}: not found\r\n`);
      link.exit(pty, 127);
      return;
    }
    if (line.includes("WSP_STATUS")) {
      link.data(pty, state.signedIn ? "Logged in using ChatGPT\r\nLogged in to github.com account someone (keyring)\r\n{\"loggedIn\": true}\r\nWSP_STATUS 0\r\n" : "Not logged in\r\nWSP_STATUS 1\r\n");
      link.exit(pty, state.signedIn ? 0 : 1);
      return;
    }
    if (line.includes("exec claude")) link.data(pty, `Opening browser to sign in...\r\nIf the browser didn't open, visit: \x1b]8;;${CLAUDE_URL}\x1b\\${CLAUDE_URL}\x1b]8;;\x1b\\\r\nPaste code here if prompted > `);
    else link.data(pty, `Press Enter to open ${DEVICE_URL} in your browser...\r\n`);
    if (!state.hold) link.exit(pty, 0);
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
  if (over.columns !== undefined) Object.assign(output, { columns: over.columns });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const text = () => stripVTControlCharacters(chunks.join(""));
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
      read: async service => {
        reads.push(service);
        return "gho_fake";
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
    expect(f.text()).toMatch(/GitHub CLI login\s+copy/);
    expect(f.text()).toMatch(/Claude Code login\s+sign in/);
    expect(f.text()).toMatch(/Sign-ins\s+7\/8\s+1 copy, 1 sign in/);
    // Codex was left unticked on the Agents screen, so its login is not offered.
    expect(f.text()).not.toContain("Codex login");
    // Past the CLI logins heading onto gh: copy -> sign in.
    await f.press(KEY.down, KEY.space, KEY.enter);

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
    // Without a Homebrew table the two formulae have no size; the toolchain and Claude Code are measured.
    expect(summary.replace(/\n\s*│?\s+/g, " ")).toMatch(/Disk\s+1\.8 GB of 16\.1 GB on the 20 GB builder \(files [\d.]+ KB, Homebrew's toolchain 1\.6 GB, agents 211\.0 MB; 3 not measured\)/);
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
    expect(out).toMatch(/GitHub CLI login: signed in \(gh auth status\)/);
    expect(out).toMatch(/Claude Code login\s+claude auth login/);
    expect(out).toMatch(/Claude Code login: signed in \(claude auth status\)/);
    expect(out).toContain("Press Enter to open https://github.com/login/device");
    expect(out.slice(signing)).toContain("o opens it on this computer");
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([
      "exec gh auth login || exit\r",
      "gh auth status; printf '\\nWSP_STATUS %s\\n' $?; exit\r",
      "exec claude auth login || exit\r",
      "claude auth status; printf '\\nWSP_STATUS %s\\n' $?; exit\r",
    ]);
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
        { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", command: "gh auth login", note: "gh auth status" },
        { id: "logins/claude", label: "Claude Code login", state: "signed-in", command: "claude auth login", note: "claude auth status" },
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
    expect(f.text()).toMatch(/Sign-ins\s+7\/8\s+2 copy, 1 sign in/);
    expect(f.text()).toMatch(/Agent logins\s+2\n/);
    await f.press(KEY.esc);
    await f.until("6/8");
    f.clear();
    await f.press(KEY.down, KEY.down, KEY.space, KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).not.toContain("Codex login");
    expect(f.text()).toMatch(/Sign-ins\s+7\/8\s+1 copy, 1 sign in/);
    expect(f.text()).toMatch(/Agent logins\s+1\n/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"));
    expect(summary).not.toContain("Codex login");
    expect(summary).toMatch(/Sign-ins\s+1 copy, 1 sign in\s+200 B/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "logins/codex")).toMatchObject({ bring: false });
    expect(saved.entries.find(e => e.id === "logins/codex")?.choice).toBeUndefined();
  });

  it("MCP servers sit under their agent on the Agents screen, say what each carries, and the summary counts them", async () => {
    const github: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", detail: "stdio: npx @modelcontextprotocol/server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)" };
    const notes: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "skip", reason: "command ~/Library/Notes/mcp is macOS-only, will not run", detail: "stdio: ~/Library/Notes/mcp; carries no secret" };
    const f = fake({ collect: async () => ({ entries: [...FIXTURE.entries, github, notes] }), columns: 140 });
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Agents");
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
    expect(screen).toContain("space tick or change • ← → fold • enter next • esc back");
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
    expect(summary).toMatch(/Sign-ins\s+1 copy, 1 sign in[^\n]*\n│\s+GitHub CLI login\s+copy/);
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
    expect(again.text()).toMatch(/\d files: identity \d, shell 1, logins 1, everything 2/);
    // The credential row is not a sign-in: the seal summary lists the two logins and never the token file.
    const signIns = again.text().slice(again.text().lastIndexOf("Sign-ins\n"), again.text().lastIndexOf("Secrets\n"));
    expect(signIns).toMatch(/GitHub CLI login\s+signed in/);
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

  it("on a terminal each cut secret is asked for hidden; the pasted value rides the pty's environment into the machine's secrets file, out of the screen and the run log", async () => {
    const f = fake();
    writeFileSync(join(f.opts.home, ".zshrc"), "export A=1\nexport A_KEY=fake\n");
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until(BOOT);
    await f.press("y");
    await f.until("Claude Code login: signed in (claude auth status)");
    await f.until("Secrets were cut from your files. Paste each to set it on the machine, or leave it empty to skip.");
    await f.until("cut from ~/.zshrc; the value is set on the machine and never shown here");
    await f.press(..."s3cret-value".split(""), KEY.enter);
    await f.until("A_KEY: set in /etc/profile.d/wsp-secrets.sh on the machine");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.secrets).toEqual([{ name: "A_KEY", path: "~/.zshrc", state: "set" }]);
    const out = f.text();
    expect(out.indexOf("Secrets were cut")).toBeGreaterThan(out.indexOf("Claude Code login: signed in"));
    expect(out.indexOf("Secrets were cut")).toBeLessThan(out.indexOf("Ready to seal golden v1"));
    expect(out).toMatch(/Secrets\n│\s+A_KEY\s+set on the machine\n/);
    expect(out).not.toContain("s3cret");
    // The machine's secrets file is read first (nothing there on a fresh builder, no fish), then the one write.
    const read = f.link.ptys.find(p => p.writes[0]!.startsWith(readCommand()))!;
    expect(read.created["env"]).toEqual({ PS1: "" });
    const pty = f.link.ptys.find(p => p.created["env"] !== undefined && "WSP_SECRET_LINE" in (p.created["env"] as object))!;
    expect(pty.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", WSP_SECRET_LINE: "export A_KEY='s3cret-value'" } });
    expect(pty.writes).toEqual([`${appendCommand(false)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(pty.killed).toBe(true);
    // gh's copy check, claude's sign-in with its check on the same link, the read, the write.
    expect(f.link.dials).toBe(4);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      logins: [{ id: "logins/gh" }, { id: "logins/claude", state: "signed-in" }],
      secrets: [{ name: "A_KEY", path: "~/.zshrc", state: "set" }],
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
    expect(again.text()).toMatch(/files: identity \d, shell 1, logins 1, everything 1/);
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
    expect(again.text()).toMatch(/files: identity \d, shell 1, logins 1, everything 1/);
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
      { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: ["~/.codex/auth.json"], bytes: 300, default: "skip" },
      { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "skip" },
    ],
  };

  it("a login the status check does not confirm is offered a retry, then the table's fallback, then a skip; o opens the page here and arms auto-open for that command only; the skip lands in the notes", async () => {
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
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
    await f.until("Codex login: not signed in (codex login status says not signed in)");
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
    // Three login ptys (default, retry, fallback), each followed by a status run; o never reached the machine.
    expect(f.link.ptys.filter(p => !p.writes[0]!.includes("WSP_STATUS")).map(p => p.writes[0])).toEqual([
      "exec codex login || exit\r",
      "exec codex login || exit\r",
      "exec codex login --device-auth || exit\r",
    ]);
    expect(f.link.ptys.filter(p => p.writes[0]!.includes("WSP_STATUS"))).toHaveLength(3);
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

  it("a login with no status command that ended with a non-zero exit is offered a retry or a skip; a clean exit stays not verified", async () => {
    const GEMINI_MANIFEST: Manifest = { entries: [FIXTURE.entries[0]!, { rung: "logins", id: "logins/gemini", label: "Gemini CLI login", group: "Agent logins", paths: ["~/.gemini/oauth_creds.json"], bytes: 300, default: "skip" }] };
    const f = fake({ hold: true, collect: async () => GEMINI_MANIFEST });
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("y");
    await f.until(/Gemini CLI login\s+gemini\n/);
    await f.until("Press Enter to open");
    await f.press("\x03");
    await f.until("Gemini CLI login: not verified (no status command known for gemini; exit 130)");
    await f.until("Gemini CLI login  r retry   s skip");
    await f.press("r");
    await f.until(/Press Enter to open[\s\S]*Press Enter to open/);
    // A clean exit with no status command is not verified but nothing to retry.
    f.link.exit(f.link.ptys.at(-1)!, 0);
    await f.until(/not verified \(no status command known for gemini\)\n/);
    await f.until(SEAL_Q(1));
    expect(f.text().split("r retry")).toHaveLength(2);
    await f.press(KEY.enter);
    const result = await run;
    expect(result.logins?.map(l => [l.state, l.exit])).toEqual([["not-verified", 0]]);
    expect(f.text()).toMatch(/Sign-ins\n│\s+Gemini CLI login\s+not verified\n/);
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
    await f.until(/not signed in \(codex login status says not signed in\)/);
    await f.until(/says not signed in[\s\S]*r retry   f retry/);
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
      { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], bytes: 200, default: "bring" },
      { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "bring" },
    ],
  };
  const STATUS_LINE = "gh auth status; printf '\\nWSP_STATUS %s\\n' $?; exit\r";

  /** gh on the fake builder: its status names the copied token invalid until gh auth login has run there. */
  function ghOnBuilder(f: Fake, o: { missing?: boolean } = {}): void {
    let loggedIn = false;
    f.link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        if (o.missing) {
          f.link.data(pty, "sh: gh: not found\r\nWSP_STATUS 127\r\n");
          f.link.exit(pty, 127);
          return;
        }
        f.link.data(pty, loggedIn ? "✓ Logged in to github.com account someone (keyring)\r\nWSP_STATUS 0\r\n" : "X Failed to log in to github.com account someone (keyring)\r\n- The token in /root/.config/gh/hosts.yml is invalid.\r\nWSP_STATUS 1\r\n");
        f.link.exit(pty, loggedIn ? 0 : 1);
        return;
      }
      if (line.startsWith("exec gh auth login")) {
        loggedIn = true;
        f.link.data(pty, `Press Enter to open ${DEVICE_URL} in your browser...\r\n`);
        f.link.exit(pty, 0);
      }
    };
  }

  /** Through the screens and the boot question; the run itself is handed back unawaited. */
  async function toTheBuilder(f: Fake): Promise<{ run: ReturnType<typeof runInit> }> {
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    await f.press(KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).toMatch(/GitHub CLI login\s+copy/);
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

  it("a copied login whose status check fails is offered the machine sign-in, which lands it as signed in; a login nothing can check stays copied", async () => {
    const f = fake({ collect: async () => COPIED_MANIFEST });
    ghOnBuilder(f);
    const { run } = await toTheBuilder(f);
    await f.until("GitHub CLI login: not signed in (copied, but gh auth status says not signed in)");
    await f.until("kubectl config: copied (not verified: no status command known for kube)");
    await f.until("GitHub CLI login  r sign in on the machine   s skip");
    expect(f.text()).not.toContain("Signing in on the machine");
    await f.press("r");
    await f.until(/GitHub CLI login\s+gh auth login\n/);
    await f.until("GitHub CLI login: signed in (gh auth status)");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    // The quiet check, the sign-in pty, then the check again.
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([STATUS_LINE, "exec gh auth login || exit\r", STATUS_LINE]);
    expect(result.logins).toEqual([
      { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", command: "gh auth login", exit: 0, note: "gh auth status" },
      { id: "logins/kube", label: "kubectl config", state: "copied", note: "not verified: no status command known for kube" },
    ]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [
        { id: "logins/gh", state: "signed-in", note: "gh auth status" },
        { id: "logins/kube", state: "copied" },
      ],
    });
    expect((await f.runtimes.at(-1)!.golden.get())?.versions[0]?.logins).toEqual([
      { name: "GitHub CLI login", state: "signed-in" },
      { name: "kubectl config", state: "copied" },
    ]);
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
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([STATUS_LINE]);
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
    expect(f.link.ptys.map(p => p.writes[0])).toEqual([STATUS_LINE]);
    expect(result.logins).toEqual([
      { id: "logins/gh", label: "GitHub CLI login", state: "not-signed-in", note: "copied, but gh auth status says not signed in" },
      { id: "logins/kube", label: "kubectl config", state: "copied", note: "not verified: no status command known for kube" },
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
    // Nobody is here to click macOS's consent dialog: the gh login, held in the Keychain, defaults to sign in on the
    // machine instead of copy, so the Keychain is never asked and the sign-in is skipped.
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
    expect(f.link.ptys.map(p => p.writes[0])).toEqual(["gh auth status; printf '\\nWSP_STATUS %s\\n' $?; exit\r"]);
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
    const saved = { entries: FIXTURE.entries.map(e => ({ ...e, bring: e.id === "identity/git-user" || e.id === "shell/zshrc" })) };
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
    const tally = out.slice(out.indexOf("Tools and agents:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools and agents: 9 installed, 1 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "jq failed: curl: no route",
    ]);
    expect(f.recipes[0]!.import?.node).toMatchObject({ floor: 16, agents: ["Codex"] });
  });

  it("a console warning while the stages animate is drawn by the stream, and a build that fails hands the console back", async () => {
    const warn = console.warn;
    const error = console.error;
    let duringPrepare: { warn: typeof console.warn; error: typeof console.error } | undefined;
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => {
        if (!cmd.includes(GOLDEN_SETUP)) return guestAnswer(cmd);
        duringPrepare = { warn: console.warn, error: console.error };
        console.warn("heartbeat for builder m1 not written: ETIMEDOUT");
        return { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" };
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(duringPrepare?.warn).not.toBe(warn);
    expect(duringPrepare?.error).not.toBe(error);
    expect(console.warn).toBe(warn);
    expect(console.error).toBe(error);
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
    const uploads = () => shared.machines[0]!.execLog.filter(c => c.includes("tar xzf")).length;
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
    const uploads = () => shared.machines[0]!.execLog.filter(c => c.includes("tar xzf")).length;
    expect(uploads()).toBe(1);

    const f = fake({ yes: true, tty: false, home: first.opts.home, manifestPath: recipePath(first.opts.statePath) });
    f.opts.secrets = { read: async () => "gho_new" };
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
    expect(ask).toMatch(/built from a different recipe: ~\/\.zshrc changed/);
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

  it("a signal during the stages hands the console back with the stream it stops", async () => {
    const warn = console.warn;
    const error = console.error;
    let duringPrepare: typeof console.warn | undefined;
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (m, cmd) => {
        if (!cmd.includes("brew install jq")) return guestAnswer(cmd);
        // The stream is animating here; the signal that follows stops it and must hand the console back.
        duringPrepare = console.warn;
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
    expect(duringPrepare).not.toBe(warn);
    expect(console.warn).toBe(warn);
    expect(console.error).toBe(error);
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
    // 300 MB files + 1600 toolchain + 53 tools + 531 agents = 2484 MiB.
    expect(lines).toContain("Disk      2.4 GB of 16.1 GB on the 20 GB builder (files 300.0 MB, Homebrew's toolchain 1.6 GB, tools 53.0 MB, agents 531.0 MB; 1 not measured)");
    const huge = new Map([["gh", { name: "gh", fullName: "gh", deps: [], bytes: 30 * 1024 * 1024 * 1024, macosOnly: false }]]);
    const over = summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0, huge).find(l => l.startsWith("Disk"));
    expect(over).toBe("Disk      31.6 GB, 15.4 GB over the 16.1 GB the 20 GB builder leaves (Homebrew's toolchain 1.6 GB, tools 30.0 GB)");
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
    expect(screen()).toMatch(new RegExp(`▸ ${APP_DATA_GROUP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+0 of 2 {2}5\\.9 KB\n`));
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
    const big = 10 * 1024 * 1024 * 1024;
    writeFileSync(path, JSON.stringify({ entries: FIXTURE.entries.map(e => ({ ...e, ...(e.id === "shell/zshrc" ? { bytes: big } : {}), bring: e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    const f = fake({ yes: true, manifestPath: path });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toMatch(/Upload\s+10\.0 GB, over the 8\.9 GB the machine's disk allows/);
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
  it("a recipe that does not fit the builder's disk is refused after the summary with the shortfall, before anything boots", async () => {
    const huge = new Map([["gh", { name: "gh", fullName: "gh", deps: [], bytes: 30 * 1024 * 1024 * 1024, macosOnly: false }]]);
    const f = fake({ yes: true, brew: async () => huge });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toContain("Reading Homebrew for sizes");
    expect(out.replace(/\n\s*│?\s+/g, " ")).toMatch(/Disk\s+31\.8 GB, 15\.6 GB over the 16\.1 GB the 20 GB builder leaves/);
    expect(out).toContain("This recipe needs about 31.8 GB on the machine; the 20 GB disk leaves 16.1 GB after the base image and 2.0 GB of headroom.");
    expect(out).toContain("Recipe saved to");
    expect(out).toContain(`Nothing was booted. Set bring to false on rows worth about 15.6 GB in ${recipePath(f.opts.statePath)}, then run wsp init --yes --manifest ${recipePath(f.opts.statePath)}; the recipe is kept.`);
    expect(out).not.toMatch(BOOT);
    expect(f.backends[0]?.machines ?? []).toHaveLength(0);
    expect(f.hosts).toBe(0);
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

  it("a Homebrew that cannot be read is a note, not a stop; the summary falls back to the measured table", async () => {
    const f = fake({ yes: true, brew: async () => { throw new Error("brew: command timed out"); } });
    const run = runInit(f.opts, f.io);
    await f.until(BOOT);
    expect(f.text()).toContain("Homebrew could not be read for sizes (brew: command timed out); formula sizes come from the measured table alone.");
    expect(f.text()).toMatch(/Disk\s+1\.8 GB of 16\.1 GB/);
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
    expect(at(/● Homebrew's toolchain \(glibc, gcc\)\s+1\.6 GB/)).toBe(at(/▾ Homebrew\s/) + 1);
    // The toolchain row also stands on a screen of taps alone, since a tap brings Homebrew.
    const tapsOnly = toolsItems([{ rung: "tools", id: "tools/brew-tap/zingzy/tap", label: "zingzy/tap", group: "Homebrew taps", paths: [], bytes: 0, default: "bring" }], new Map());
    expect(tapsOnly[0]!.id).toBe("tools/homebrew-toolchain");
    expect(tapsOnly[0]!.follows!(new Set(["tools/brew-tap/zingzy/tap"]))).toBe(true);
    expect(tapsOnly[0]!.follows!(new Set())).toBe(false);
    expect(screen).toMatch(/● gh\s+50\.0 MB/);
    expect(screen).toMatch(/● jq\s+3\.0 MB/);
    expect(screen).toMatch(/● pnpm\s+not measured/);
    expect(screen).toMatch(/○ rectangle\s+stays here/);
    // Files from the earlier screens, the toolchain and the two formulae so far; pnpm has no size.
    expect(screen).toMatch(/Disk: 1\.6 GB of 16\.1 GB on the 20 GB builder\n┃  files 1[\d.]+ KB, Homebrew's toolchain 1\.6 GB, tools 53\.0 MB; 1 not measured\n/);
    // Past the group header, the toolchain row and gh onto jq; its detail names the closure and where the number came from.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
    expect(f.text()).toContain("about 3.0 MB with 1 dependency, from this Mac's Homebrew; brought by default");
    // Unticking jq drops its closure from the total.
    await f.press(KEY.space);
    expect(f.text().split("\n").filter(l => l.includes("Homebrew's toolchain 1.6 GB, tools")).at(-1)).toMatch(/tools 50\.0 MB/);
    await f.press(KEY.enter);
    await f.until("Agents");
    // Onto Claude Code, whose detail names what installs and what travels.
    await f.press(KEY.down);
    const agents = f.text().slice(f.text().lastIndexOf("Agents"));
    expect(agents).toMatch(/● Claude Code\s+211\.0 MB/);
    expect(agents).toMatch(/○ Codex\s+320\.0 MB/);
    // An agent nobody measured says so rather than showing its config size in the install column.
    const aider = selectItem({ rung: "agents", id: "agents/aider", label: "Aider", paths: ["~/.aider.conf.yml"], bytes: 900, default: "skip" });
    expect(aider.hint).toBe("not measured");
    expect(aider.detail[1]).toBe("installs on the machine (size not measured); its config (900 B) comes along");
    const zed = selectItem({ rung: "agents", id: "agents/zed", label: "Zed", paths: ["~/.config/zed"], bytes: 900, default: "skip" });
    expect(zed.hint).toBe("900 B");
    expect(agents).toContain("installs about 211.0 MB on the machine (measured 2026-09-05); its config (39.1 KB) comes along");
    expect(agents).toMatch(/Disk: 1\.8 GB of 16\.1 GB on the 20 GB builder\n┃  files [\d.]+ KB, Homebrew's toolchain 1\.6 GB, tools 50\.0 MB, agents 211\.0 MB; 1 not measured\n/);
    await f.press(KEY.ctrlC);
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
    expect(out).toMatch(/Tools and agents: 0 installed, 1 removed, 0 failed, 0 skipped; the list is in .*golden-import\.json/);
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
    const tally = out.slice(out.indexOf("Tools and agents:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇●]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools and agents: 0 installed, 0 removed, 0 failed, 1 not removed, 0 skipped; the list is in .*golden-import\.json$/),
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
