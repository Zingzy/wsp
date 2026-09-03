// SPDX-License-Identifier: AGPL-3.0-only
// wsp init end to end against the stub backend: keys in, the seven screens,
// the summary and confirm, prepare with its stage stream, the hand-off. The
// runtime and host are the real ones over fakes; only the terminal is faked.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { RUNGS } from "@wsp/collect";
import { createRuntime, memoryStore, type GoldenRecipe, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { GOLDEN_SETUP } from "../src/doctor.js";
import { loadManifest } from "../src/init-recipe.js";
import { reduceStages, runInit, type InitIO, type InitOptions } from "../src/init.js";
import type { HostHandle } from "../src/server.js";
import { FIXTURE } from "./init-fixture.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";

const SOLARI = "slr_live_fake_solari_key";
const KEY = { down: "\x1b[B", space: " ", enter: "\r", esc: "\x1b" };
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\//;

interface Fake {
  io: InitIO;
  opts: InitOptions;
  text(): string;
  clear(): void;
  press(...keys: string[]): Promise<void>;
  until(needle: string | RegExp, ms?: number): Promise<void>;
  opened: string[];
  copied: string[];
  backends: StubBackend[];
  recipes: GoldenRecipe[];
  runtimes: Runtime[];
  checklists: { label: string; command: string }[][];
  hosts: number;
  /** Keychain services the fake reader was asked for. */
  reads: string[];
}

function fake(over: Partial<InitOptions> & { tty?: boolean; env?: Record<string, string> } = {}): Fake {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const text = () => stripVTControlCharacters(chunks.join(""));
  const clear = () => void chunks.splice(0);
  const opened: string[] = [];
  const copied: string[] = [];
  const backends: StubBackend[] = [];
  const recipes: GoldenRecipe[] = [];
  const runtimes: Runtime[] = [];
  const checklists: { label: string; command: string }[][] = [];
  const counters = { hosts: 0 };
  const io: InitIO = {
    input,
    output,
    isTTY: over.tty ?? true,
    env: over.env ?? {},
    open: async url => {
      opened.push(url);
      return true;
    },
    copy: async t => {
      copied.push(t);
      return true;
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
  const { tty: _tty, env: _env, ...rest } = over;
  const opts: InitOptions = {
    yes: false,
    collect: async () => FIXTURE,
    keys: { solari: SOLARI },
    statePath: join(dir, "state.json"),
    home,
    platform: "darwin",
    secrets: {
      read: async service => {
        reads.push(service);
        return "gho_fake";
      },
    },
    runtime: recipe => {
      recipes.push(recipe);
      const backend = stubBackend();
      backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
      runtimes.push(rt);
      return rt;
    },
    host: async (rt: Runtime, builder, checklist) => {
      counters.hosts += 1;
      expect(builder.id).toBe(backends.at(-1)?.machines[0]?.id);
      checklists.push(checklist);
      void rt;
      const handle: HostHandle = { port: 4400, wsPort: 4410, authToken: "tok", close: async () => {} };
      return handle;
    },
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
    copied,
    backends,
    recipes,
    runtimes,
    checklists,
    get hosts() {
      return counters.hosts;
    },
    reads,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("wsp init, interactive", () => {
  it("detects first, walks the seven rungs, confirms once, prepares through the runtime, hands off", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);

    await f.until("Identity");
    const first = f.text();
    // Screen one is the detection result, before any question.
    expect(first).toContain("Found on this computer");
    expect(first).toContain("Tools          4  3 can come");
    expect(first).toContain("Nothing has left this computer.");
    expect(first.indexOf("Found on this computer")).toBeLessThan(first.indexOf("1/7"));
    expect(first).toContain("1/7");
    expect(first).not.toMatch(/claude|codex/i);
    await f.press(KEY.enter);
    await f.until("Shell");
    expect(f.text()).toContain("2/7");
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
    expect(f.text()).toContain("GitHub CLI login  copy from this computer");
    expect(f.text()).toContain("Claude Code login  sign in on the machine");
    // gh: copy -> sign in on the machine.
    await f.press(KEY.space, KEY.enter);

    await f.until("Boot a machine");
    const summary = f.text().slice(f.text().lastIndexOf("Summary"));
    expect(summary).toContain("Identity");
    expect(summary).toContain("~/.ssh/config");
    expect(summary).not.toContain("id_ed25519");
    expect(summary).toContain("Upload");
    expect(summary).toContain("Nothing has left this computer yet.");
    expect(summary).toContain("Sign in on the machine: GitHub CLI login, Claude Code login");
    expect(f.backends).toHaveLength(0);
    await f.press("y");

    await f.until(URL_RE);
    await f.press(KEY.enter);
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.handle?.port).toBe(4400);

    const out = f.text();
    const order = ["Machine created", "Base installed", "Setup applied", "Files uploaded", "Tools installed", "Agents installed", "Ready"].map(s => out.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("node v22.12.0");
    expect(out).toContain("3 files: identity 2, shell 1");
    expect(out).toContain("Claude Code installed");
    expect(out).toContain("golden-import.json");
    expect(out).not.toMatch(/—|\p{Emoji_Presentation}/u);
    expect(out).not.toContain(SOLARI);
    // gh was switched to sign in on the machine, so its Keychain token was never asked for.
    expect(f.reads).toEqual([]);

    const backend = f.backends[0]!;
    expect(backend.machines).toHaveLength(1);
    const log = backend.machines[0]!.execLog;
    expect(log.some(c => c.includes("tar xzf") && c.includes("--no-same-owner"))).toBe(true);
    expect(log.filter(c => c.includes("brew install") || c.includes("npm install -g pnpm"))).toHaveLength(3);
    expect(log.some(c => c.includes(GOLDEN_SETUP))).toBe(true);
    expect(log.indexOf(log.find(c => c.includes("tar xzf"))!)).toBeLessThan(log.indexOf(log.find(c => c.includes("brew install"))!));
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      files: { bytes: expect.any(Number) },
      tools: [{ id: "tools/homebrew", outcome: "installed" }, { id: "tools/brew/gh", outcome: "installed" }, { id: "tools/brew/jq", outcome: "installed" }, { id: "tools/npm/pnpm", outcome: "installed" }],
      agents: [{ id: "agents/claude", outcome: "installed" }],
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
    expect(saved.entries.filter(e => e.rung === "logins").map(e => e.choice)).toEqual(["machine", "machine"]);
    expect(out).toContain("golden-recipe.json");
    expect(f.checklists[0]).toEqual([
      { label: "GitHub CLI login", command: "gh auth login" },
      { label: "Claude Code login", command: "claude, then /login" },
    ]);

    // The terminal keeps reporting after the hand-off: the seal stages arrive as the browser drives them.
    const rt = f.runtimes[0]!;
    await rt.golden.seal(f.backends[0]!.machines[0]!.id);
    await f.until("Sealed");
    const after = f.text().slice(out.length);
    expect(after.indexOf("Snapshot taken")).toBeLessThan(after.indexOf("Fork booted and checked"));
    expect(after).toContain("Golden v1 sealed");
  });

  it("escape on a later rung replays the earlier answer; c copies the address at the hand-off", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await f.until("Identity");
    // all row, git (locked), ssh config: untick ssh config.
    await f.press(KEY.down, KEY.down, KEY.space, KEY.enter);
    await f.until("Shell");
    f.clear();
    await f.press(KEY.esc);
    await f.until("1/7");
    f.clear();
    await f.press(KEY.enter);
    await f.until("2/7");
    for (const rung of ["Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Boot a machine");
    expect(f.text()).not.toContain("~/.ssh/config");
    await f.press("y");
    await f.until(URL_RE);
    await f.press("c");
    await f.until("copied");
    expect(f.copied).toEqual([expect.stringMatching(URL_RE)]);
    await f.press(KEY.enter);
    expect((await run).code).toBe(0);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "identity/ssh-config")?.bring).toBe(false);
    expect(saved.entries.find(e => e.id === "identity/git-user")?.bring).toBe(true);
  });

  it("no at the confirm boots nothing and saves nothing", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Boot a machine");
    await f.press("n");
    expect((await run).code).toBe(1);
    expect(f.backends).toHaveLength(0);
    expect(existsSync(join(dirs[0]!, "golden-recipe.json"))).toBe(false);
    expect(f.hosts).toBe(0);
  });

  it("a prepare that fails after the hand-off never happened is reported once, and a failed seal after it is reported too", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      f.backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
      f.runtimes.push(rt);
      return rt;
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const rt = f.runtimes[0]!;
    f.backends[0]!.execImpl = () => ({ exitCode: 3, stdout: "", stderr: "claude: not found" });
    await rt.golden.seal(f.backends[0]!.machines[0]!.id).catch(() => {});
    await f.until("Seal failed");
    expect(f.text()).toContain("Run wsp init again");
  });

  it("the detect spinner counts each rung as the collector finishes it, before the found note", async () => {
    const f = fake({
      collect: async onRung => {
        for (const rung of RUNGS) onRung(rung, FIXTURE.entries.filter(e => e.rung === rung).length);
        return FIXTURE;
      },
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/7");
    const t = f.text();
    expect(t).toContain("Reading this computer  Identity 3");
    expect(t).toContain("Reading this computer  Identity 3, Shell 2, Editors 1, Toolchains 1, Tools 4, Agents 2, Sign-ins 2");
    expect(t.indexOf("Sign-ins 2")).toBeLessThan(t.indexOf("Found on this computer"));
    for (const rung of ["Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins"]) {
      await f.until(rung);
      await f.press(KEY.enter);
    }
    await f.until("Boot a machine");
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("nothing found on this machine still shows the screens' empty state and reaches the confirm", async () => {
    const f = fake({ collect: async () => ({ entries: [] }) });
    const run = runInit(f.opts, f.io);
    await f.until("Boot a machine");
    expect(f.text()).toContain("Found nothing to bring");
    expect(f.text()).toContain("--manifest");
    await f.press("n");
    expect((await run).code).toBe(1);
  });
});

describe("wsp init, flags and no terminal", () => {
  it("without a terminal it behaves as --yes: defaults taken, nothing asked, the address printed", async () => {
    const f = fake({ tty: false });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.text()).toContain("taken as yes");
    expect(f.text()).toMatch(URL_RE);
    expect(f.backends[0]!.machines).toHaveLength(1);
    expect(f.opened).toEqual([]);
    // The gh login defaults to copy, so its token was read from the Keychain, once, through the injected reader.
    expect(f.reads).toEqual(["gh:github.com"]);
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
    expect(f.opened).toEqual([]);
    expect(f.copied).toEqual([]);
    // No agent ticked: the harness installs nothing and names nothing; the two files still travel.
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log).toContain("true");
    expect(log.some(c => c.includes(GOLDEN_SETUP))).toBe(false);
    expect(log.some(c => c.includes("tar xzf"))).toBe(true);
    // Off a terminal a step prints once, done, with its last detail and how long it took.
    expect(out).toMatch(/Setup applied  [\d.]+ (B|KB) packed  \d+\.\ds/);
    expect(out).toMatch(/Files uploaded  [\d.]+ (B|KB) in [\d.]+s  \d+\.\ds/);
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
    expect(f.backends[0]!.machines).toHaveLength(1);
    expect(f.backends[0]!.machines[0]!.killed).toBe(false);
  });

  it("a failed upload reports the stage and the detail and exits 1 with no host", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("tar xzf") ? { exitCode: 2, stdout: "", stderr: "gzip: stdin: not in gzip format" } : { exitCode: 0, stdout: "", stderr: "" });
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    expect(f.text()).toMatch(/Uploading your files failed/);
    expect(f.text()).toContain("not in gzip format");
  });

  it("a tool or agent that fails is a warning in the stream, not the end of the build", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("brew install jq") || cmd.includes(GOLDEN_SETUP) ? { exitCode: 1, stdout: "", stderr: "curl: no route" } : { exitCode: 0, stdout: "", stderr: "" });
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.text()).toContain("3 installed, 1 failed: jq (curl: no route)");
    expect(f.text()).toContain("Claude Code failed (curl: no route)");
    expect(f.text()).toContain("Ready");
  });
});

describe("stage stream", () => {
  const ev = (stage: string, detail?: string) => ({ type: "golden.stage" as const, name: "default", stage, ...(detail !== undefined ? { detail } : {}) });

  it("renders one step per stage with start and end labels and a tail of details", () => {
    const view = reduceStages([ev("creating", "sandbox from default"), ev("deploying-daemon", "node v22"), ev("installing-harness")]);
    expect(view.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["deploying-daemon", "done"],
      ["applying-setup", "done"],
      ["uploading-files", "done"],
      ["installing-tools", "done"],
      ["installing-harness", "current"],
      ["ready", "pending"],
    ]);
    expect(view.steps.slice(2, 5).map(s => [s.start, s.end])).toEqual([
      ["Applying your setup", "Setup applied"],
      ["Uploading your files", "Files uploaded"],
      ["Installing tools", "Tools installed"],
    ]);
    expect(view.steps[0]).toMatchObject({ start: "Creating the machine", end: "Machine created", tail: ["sandbox from default"] });
    expect(view.steps[1]!.tail).toEqual(["node v22"]);
    expect(view.failure).toBeUndefined();
  });

  it("a stage not reported counts as done once a later one arrives; ready finishes; failed carries the detail", () => {
    const done = reduceStages([ev("creating"), ev("installing-harness"), ev("ready")]);
    expect(done.steps.map(s => s.state)).toEqual(["done", "done", "done", "done", "done", "done", "done"]);
    const failed = reduceStages([ev("creating"), ev("failed", "golden setup failed (exit 1): curl: no route")]);
    expect(failed.steps[0]!.state).toBe("failed");
    expect(failed.failure).toBe("golden setup failed (exit 1): curl: no route");
  });

  it("frames for another golden are ignored", () => {
    const view = reduceStages([{ type: "golden.stage" as const, name: "nightly", stage: "ready" }]);
    expect(view.steps.every(s => s.state === "pending")).toBe(true);
  });
});
