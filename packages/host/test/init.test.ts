// SPDX-License-Identifier: AGPL-3.0-only
// wsp init end to end against the stub backend: keys in, the seven screens,
// the summary and confirm, prepare with its stage stream, the hand-off. The
// runtime and host are the real ones over fakes; only the terminal is faked.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { RUNGS } from "@wsp/collect";
import type { BackendPricing } from "@wsp/engine";
import { createRuntime, memoryStore, type GoldenRecipe, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SETUP } from "../src/doctor.js";
import { loadManifest, recipePath } from "../src/init-recipe.js";
import { reduceStages, runInit, stageLine, type InitIO, type InitOptions } from "../src/init.js";
import type { HostHandle } from "../src/server.js";
import { FIXTURE } from "./init-fixture.js";
import { guestAnswer, stubBackend, type StubBackend } from "./stub-backend.js";

const SOLARI = "slr_live_fake_solari_key";
const KEY = { down: "\x1b[B", space: " ", enter: "\r", esc: "\x1b" };
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\//;
const BOOT = /Boot a \d+ vCPU/;
const PRICING: BackendPricing = { rateUsdPerHour: s => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 } };

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

function fake(over: Partial<InitOptions> & { tty?: boolean; env?: Record<string, string>; columns?: number } = {}): Fake {
  const input = new PassThrough();
  const output = new PassThrough();
  if (over.columns !== undefined) Object.assign(output, { columns: over.columns });
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
  const store = memoryStore();
  const { tty: _tty, env: _env, columns: _columns, ...rest } = over;
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
    expect(first).toMatch(/Tools\s+4\s+3 can come/);
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
    expect(f.text()).toMatch(/GitHub CLI login\s+copy/);
    expect(f.text()).toMatch(/Claude Code login\s+sign in/);
    expect(f.text()).toMatch(/Sign-ins\s+7\/7\s+1 copy, 1 sign in/);
    // Codex was left unticked on the Agents screen, so its login is not offered.
    expect(f.text()).not.toContain("Codex login");
    // Past the CLI logins heading onto gh: copy -> sign in.
    await f.press(KEY.down, KEY.space, KEY.enter);

    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"), f.text().lastIndexOf("Recipe saved"));
    // One line per rung, the sign-ins under theirs with the answer each got, then the three closing lines.
    const body = summary.split("\n").map(l => l.replace(/^│\s{2}|\s*│$/g, "").trimEnd()).filter(l => l !== "" && !/^[─├╯╮◇ ]*$/.test(l) && !l.startsWith("Summary"));
    expect(body.map(l => l.trim().split(/\s{2,}/)[0])).toEqual([
      "Identity", "Shell", "Editors", "Toolchains", "Tools", "Agents", "Sign-ins", "GitHub CLI login", "Claude Code login", "Upload", "Installs",
    ]);
    expect(summary).toMatch(/Identity\s+2 of 3\s+1\.7 KB/);
    expect(summary).toMatch(/Tools\s+3 of 4\s+│/);
    expect(summary).toMatch(/Sign-ins\s+0 of 2/);
    expect(summary).toMatch(/GitHub CLI login\s+sign in/);
    expect(summary).toMatch(/Claude Code login\s+sign in/);
    expect(summary).not.toContain("id_ed25519");
    expect(summary).toMatch(/Upload\s+\d[\d.]* [KM]B, nothing has left this computer yet/);
    // Their three ticked tools; Homebrew's own glibc and gcc are named apart, not counted as theirs.
    expect(summary).toMatch(/Installs\s+Claude Code, 3 tools plus Homebrew's toolchain/);
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
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
    // A finished stage: label, detail, and its duration flush against the right edge (80 columns off a terminal).
    const base = out.split("\n").filter(l => /Base installed/.test(l)).at(-1)!;
    expect(base).toMatch(/Base installed\s+node v22\.12\.0\s+\d+\.\ds$/);
    expect(base.length).toBe(80);
    // The hand-off is three lines: the address, what to do there, the keys.
    const at = out.indexOf("Opened http://");
    expect(out.slice(at).split("\n").slice(0, 3).map(l => l.replace(/^│\s+/, ""))).toEqual([
      expect.stringMatching(/^Opened http:\/\/127\.0\.0\.1:\d+\/$/),
      "Sign in where the checklist says, then save the golden.",
      "c copy the address   enter continue",
    ]);
    expect(out).not.toMatch(/—|\p{Emoji_Presentation}/u);
    expect(out).not.toContain(SOLARI);
    // gh was switched to sign in on the machine, so its Keychain token was never asked for.
    expect(f.reads).toEqual([]);

    const backend = f.backends[0]!;
    expect(backend.machines).toHaveLength(1);
    const log = backend.machines[0]!.execLog;
    expect(log.some(c => c.includes("tar xzf") && c.includes("--no-same-owner"))).toBe(true);
    expect(log.filter(c => c.includes("brew install") || c.includes("npm install -g pnpm"))).toHaveLength(5);
    expect(log.map(c => /brew install ([a-z@.-]+)/.exec(c)?.[1]).filter(Boolean)).toEqual(["glibc", "gcc", "gh", "jq"]);
    expect(log.some(c => c.includes(GOLDEN_SETUP))).toBe(true);
    expect(log.indexOf(log.find(c => c.includes("tar xzf"))!)).toBeLessThan(log.indexOf(log.find(c => c.includes("brew install"))!));
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      files: { bytes: expect.any(Number) },
      homebrew: { tag: expect.stringMatching(/^6\./), commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
      tools: [{ id: "tools/homebrew", outcome: "installed" }, { id: "tools/brew-toolchain/glibc", outcome: "installed" }, { id: "tools/brew-toolchain/gcc", outcome: "installed" }, { id: "tools/brew/gh", outcome: "installed" }, { id: "tools/brew/jq", outcome: "installed" }, { id: "tools/npm/pnpm", outcome: "installed" }],
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
    expect(saved.entries.filter(e => e.rung === "logins").map(e => e.choice)).toEqual(["machine", "machine", undefined]);
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
    // The cursor starts on the all row and skips the git bullet: one down is ssh config, untick it.
    await f.press(KEY.down, KEY.space, KEY.enter);
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
    await f.until(BOOT);
    expect(f.text().slice(f.text().lastIndexOf("Summary"))).toMatch(/Identity\s+1 of 3/);
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
    expect(ask).toContain(`${S_RADIO_INACTIVE} Yes`);
    expect(ask).toContain(`${S_RADIO_ACTIVE} No`);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
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
    expect(f.text()).toMatch(/Sign-ins\s+7\/7\s+2 copy, 1 sign in/);
    expect(f.text()).toMatch(/Agent logins\s+2\n/);
    await f.press(KEY.esc);
    await f.until("6/7");
    f.clear();
    await f.press(KEY.down, KEY.down, KEY.space, KEY.enter);
    await f.until("Sign-ins");
    expect(f.text()).not.toContain("Codex login");
    expect(f.text()).toMatch(/Sign-ins\s+7\/7\s+1 copy, 1 sign in/);
    expect(f.text()).toMatch(/Agent logins\s+1\n/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"));
    expect(summary).not.toContain("Codex login");
    expect(summary).toMatch(/Sign-ins\s+1 of 2/);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "logins/codex")).toMatchObject({ bring: false });
    expect(saved.entries.find(e => e.id === "logins/codex")?.choice).toBeUndefined();
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
    await f.until("1/7");
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

describe("wsp init, flags and no terminal", () => {
  it("without a terminal it behaves as --yes: defaults taken, nothing asked, the address printed", async () => {
    const f = fake({ tty: false });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.text()).toContain("Taken as yes (no terminal)");
    expect(f.text()).toMatch(URL_RE);
    expect(f.backends[0]!.machines).toHaveLength(1);
    expect(f.opened).toEqual([]);
    // The gh login defaults to copy, so its token was read from the Keychain, once, through the injected reader.
    expect(f.reads).toEqual(["gh:github.com"]);
  });

  it("a Keychain login the reader refuses is read before anything boots, turns into a sign-in on the machine, and says so before the confirm", async () => {
    const f = fake({ yes: true });
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
    expect(f.checklists[0]).toEqual(expect.arrayContaining([{ label: "GitHub CLI login", command: "gh auth login" }]));
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
    expect(f.opened).toEqual([]);
    expect(f.copied).toEqual([]);
    // No agent ticked: the harness installs nothing and names nothing; the two files still travel.
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log).toContain("true");
    expect(log.some(c => c.includes(GOLDEN_SETUP))).toBe(false);
    expect(log.some(c => c.includes("tar xzf"))).toBe(true);
    // Off a terminal a step prints once, done, with its last detail and how long it took flush right.
    expect(out).toMatch(/Setup applied\s+[\d.]+ (B|KB) packed\s+\d+\.\ds$/m);
    expect(out).toMatch(/Files uploaded\s+[\d.]+ (B|KB) in [\d.]+s\s+\d+\.\ds$/m);
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

  it("a tool or one of several agents that fails is a warning in the stream, named on its own line, not the end of the build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-init-manifest-"));
    dirs.push(dir);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: FIXTURE.entries.map(e => ({ ...e, bring: e.id === "agents/codex" ? true : e.bring ?? (e.default === "bring" && e.reason === undefined) })) }));
    const f = fake({ yes: true, manifestPath: path });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("brew install jq") || cmd.includes(GOLDEN_SETUP) ? { exitCode: 1, stdout: "", stderr: "curl: no route" } : guestAnswer(cmd));
      f.backends.push(backend);
      f.recipes.push(recipe);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Tools installed\s+5 installed, 1 failed/);
    expect(out).toMatch(/Agents installed\s+Codex installed; Claude/);
    expect(out).toContain("Ready");
    // The stage line is cut to the width; the names come back in full under the tally.
    const tally = out.slice(out.indexOf("Tools and agents:"));
    expect(tally.split("\n").slice(0, 3).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools and agents: 6 installed, 2 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "jq failed: curl: no route",
      "Claude Code failed: curl: no route",
    ]);
    expect(f.recipes[0]!.import?.node).toMatchObject({ floor: 16, agents: ["Codex"] });
  });

  it("every ticked agent failing ends the build: one line per agent with its reason, the builder killed, and an offer to start over", async () => {
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
    expect(out.split("\n").map(l => l.replace(/^│\s+/, ""))).toEqual(expect.arrayContaining(["no agent installed, so there is nothing to seal:", "Claude Code: curl: (6) Could not resolve host"]));
    expect(out).toContain("Run wsp init again to start over; the recipe is kept.");
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({ agents: [{ id: "agents/claude", outcome: "failed" }] });
  });

  it("a builder from an earlier run built from a different recipe is listed with its age, cost and reason, and nothing boots beside it", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const earlier = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096 } });
    await earlier.golden.prepare();
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toContain("A builder from an earlier wsp init is still running on the account:");
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe/);
    expect(out).toContain("Nothing was booted. Kill it first (the Solari console lists it), then run wsp init again.");
    expect(out).not.toContain("save it");
    // The refusal came before any consent dialog: the Keychain was never asked.
    expect(f.reads).toEqual([]);
    expect(out).not.toMatch(BOOT);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a builder from an earlier run that was paused is listed as unsealable, and nothing boots beside it", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    expect((await runInit(first.opts, first.io)).code).toBe(0);
    shared.machines[0]!.paused = true;

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; cannot be sealed after a restart/);
    expect(out).toContain("Nothing was booted. Kill it first (the Solari console lists it), then run wsp init again.");
    expect(shared.machines).toHaveLength(1);
  });

  it("an earlier builder wearing another setup's owner label is refused with those words, and nothing boots beside it", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    expect((await runInit(first.opts, first.io)).code).toBe(0);
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
    expect((await runInit(first.opts, first.io)).code).toBe(0);
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
    expect(out).not.toContain("Kill it first");
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a placeholder left mid-setup by a dead process is listed as unfinished and refused, even on the same recipe; nothing boots beside it", async () => {
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
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; its setup never finished/);
    expect(out).toContain("Nothing was booted. Kill it first (the Solari console lists it), or run wsp, whose first sweep stops it; then run wsp init again.");
    expect(out).not.toContain("Attaching");
    expect(out).not.toMatch(BOOT);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("when another builder blocks, the refusal names the one this run could reuse", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    expect((await runInit(first.opts, first.io)).code).toBe(0);
    const other = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096 } });
    await other.golden.prepare();

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe });
    };
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m2\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe/);
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; reusable by this run once the others are stopped/);
    expect(shared.machines).toHaveLength(2);
    expect(shared.machines.some(m => m.killed)).toBe(false);
  });

  it("a Keychain refusal rehashes the recipe the builder carries, so wsp init --manifest on the saved recipe attaches after a crash", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
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
    expect((await runInit(first.opts, first.io)).code).toBe(0);
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
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual([]);
    expect(f.text()).toContain("Attaching to your earlier builder: default (m1)");
    expect(shared.machines).toHaveLength(1);
  });

  it("a first-life builder from an earlier run with the same recipe is attached to: no boot question, every stage already applied, one machine", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    expect((await runInit(first.opts, first.io)).code).toBe(0);
    expect(shared.machines).toHaveLength(1);

    // The same home, so the file rows hash the same; a second process is a second runtime over the same
    // store. Off a terminal each stage prints once, so the lines can be counted.
    const f = fake({ yes: true, tty: false, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" } });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.hosts).toBe(1);
    const out = f.text();
    expect(out).toMatch(/Attaching to your earlier builder: default \(m1\), \d+ s old, about \$\d+\.\d\d so far\. Nothing new boots; stages already applied are skipped\./);
    expect(out).not.toMatch(BOOT);
    expect(out).not.toContain("Creating the machine");
    expect(out.match(/(Setup applied|Files uploaded|Tools installed|Agents installed)\s+already applied/g)).toHaveLength(4);
    expect(out).toContain("Ready");
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
    expect((await store.list("builders")).map(b => (b as { id: string; firstLife: boolean }).firstLife)).toEqual([true]);
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

  it("a frame's arrival time gives the stage it ends its duration; the last stage has none", () => {
    const view = reduceStages([
      { ...ev("creating"), at: 1_000 },
      { ...ev("deploying-daemon"), at: 4_200 },
      { ...ev("deploying-daemon", "node v22"), at: 4_900 },
      { ...ev("installing-harness"), at: 5_000 },
      { ...ev("ready"), at: 65_500 },
    ]);
    // The second deploying-daemon frame carries the detail; it does not restart that stage's clock.
    expect(view.steps.map(s => s.ms)).toEqual([3_200, 800, undefined, undefined, undefined, 60_500, undefined]);
  });

  it("a stage line pads the label, keeps the detail, and puts the duration flush right at the width", () => {
    const line = stripVTControlCharacters(stageLine("o", "Base installed", "node v22.12.0", 3_200, 60, 20));
    expect(line).toBe("o  Base installed        node v22.12.0                  3.2s");
    expect(line.length).toBe(60);
    const long = stripVTControlCharacters(stageLine("o", "Base installed", "x".repeat(80), 61_000, 60, 20));
    expect(long.length).toBe(60);
    expect(long).toMatch(/x…  1m 01s$/);
    expect(stripVTControlCharacters(stageLine("o", "Ready", undefined, undefined, 60, 20))).toBe("o  Ready");
  });

  it("frames for another golden are ignored", () => {
    const view = reduceStages([{ type: "golden.stage" as const, name: "nightly", stage: "ready" }]);
    expect(view.steps.every(s => s.state === "pending")).toBe(true);
  });
});
