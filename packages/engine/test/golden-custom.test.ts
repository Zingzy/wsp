// SPDX-License-Identifier: AGPL-3.0-only
// The rows a recipe carries that the catalog does not: where they land in the
// plan, what they run with, and what the tools stage records for them.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BREW, LINUXBREW_SHIM } from "@wsp/catalog";
import { shellQuote, type RecipeCustomRow } from "@wsp/protocol";
import { CUSTOM_PREFIX, CUSTOM_PRELUDE, customInstallsFor, recipeDigest, recipeHash, toolInstallsFor, type RecipeEntry } from "../src/golden-import.js";
import { diffRecipes } from "../src/golden-diff.js";
import { installTools } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";

const just: RecipeCustomRow = { kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" };
const ruff: RecipeCustomRow = { kind: "custom", id: "ruff", name: "ruff", install: ["uv tool install ruff"], check: "ruff --version", why: "used in wsp" };

const row = (over: Partial<RecipeEntry> & { id: string }): RecipeEntry => ({ rung: "tools", label: over.id, paths: [], bytes: 0, default: "bring", bring: true, linux: "yes", ...over });

/** A command run through this machine's own bash, as a guest's shell would run it. */
function shellOut(cmd: string): ExecResult {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** A builder that answers every script from a table, keyed by a fragment of it; anything else exits 0. The batched
 * check run answers the way a guest's shell would: exit 0, with the marker line the stage reads for the row that is
 * not there. `checksBroken` is the other case, the run itself failing. */
function builder(over: { fail?: string; checkFails?: string; checksBroken?: boolean } = {}): Machine & { scripts: string[]; inline: string[] } {
  const scripts: string[] = [];
  const inline: string[] = [];
  const answer = (text: string, seen: string[]): ExecResult => {
    seen.push(text);
    if (over.fail !== undefined && text.includes(over.fail)) return { exitCode: 1, stdout: "", stderr: `Error: ${over.fail} is not available` };
    if (text.includes("wsp-check")) {
      if (over.checksBroken === true) return { exitCode: 1, stdout: "", stderr: "bash: no such shell" };
      const id = over.checkFails !== undefined && text.includes(over.checkFails) ? `wsp-check tools/custom/ruff command not found\n` : "";
      return { exitCode: 0, stdout: id, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return {
    id: "m1",
    kind: "sandbox",
    exec: async cmd => answer(cmd, inline),
    run: async script => answer(script, scripts),
    snapshot: async () => "snap",
    pause: async () => {},
    resume: async () => {},
    kill: async () => {},
    state: async () => "running",
    downloadUrl: async () => "https://x",
    uploadUrl: async () => "https://x",
    scripts,
    inline,
  };
}

describe("the plan's rows outside the catalog", () => {
  it("run after every catalog road, in the order the recipe carries them", () => {
    const plan = toolInstallsFor([row({ id: "tools/npm/turbo" }), row({ id: "tools/brew/fd" })], new Map(), [just, ruff]);
    expect(plan.installs.slice(-2).map(t => t.id)).toEqual([`${CUSTOM_PREFIX}just`, `${CUSTOM_PREFIX}ruff`]);
    expect(plan.installs.some(t => t.id === "tools/npm/turbo")).toBe(true);
    expect(plan.installs.findIndex(t => t.id === `${CUSTOM_PREFIX}just`)).toBeGreaterThan(plan.installs.findIndex(t => t.id === "tools/npm/turbo"));
  });

  it("run their lines as given, under the env the catalog roads run with", () => {
    const [install] = customInstallsFor([just]);
    expect(install!.cmd).toBe(`${CUSTOM_PRELUDE}\nbrew install just`);
    expect(CUSTOM_PRELUDE).toContain("export PATH=");
    expect(CUSTOM_PRELUDE).toContain("DEBIAN_FRONTEND=noninteractive");
    // Homebrew refuses to run as the root a custom row runs as, so brew here is the catalog's own for the linuxbrew user.
    expect(CUSTOM_PRELUDE).toContain(LINUXBREW_SHIM);
    expect(install!.label).toBe("just");
    expect(install!.check).toBe("command -v just");
  });

  it("keep a hand-written brew line's own quoting: the arguments reach Homebrew as they were typed", () => {
    // The shim runs for real here, under this machine's bash, with the whole script quoted the way the guard quotes
    // it. su is a stand-in on PATH (nobody here may run one, and macOS's su takes other flags), reading the same
    // form the shim writes: -s SHELL USER -c SCRIPT -- ARGS. What it proves is the shim's own doing: the quoting
    // survives two shells, and each argument arrives whole.
    const dir = mkdtempSync(join(tmpdir(), "wsp-shim-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "su"), '#!/bin/sh\nshell=/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -s) shell="$2"; shift 2 ;; -c) script="$2"; shift 2 ;; --) shift; break ;; *) shift ;; esac; done\nexec "$shell" -c "$script" "$@"\n', { mode: 0o755 });
    writeFileSync(join(dir, "brew-stub"), '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n', { mode: 0o755 });
    const script = `${LINUXBREW_SHIM.replace(BREW, join(dir, "brew-stub"))}\nbrew install "some formula" --flag`;
    const out = execFileSync("bash", ["-c", `bash -c ${shellQuote(script)}`], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` } });
    expect(out.trim().split("\n")).toEqual(["[install]", "[some formula]", "[--flag]"]);
  });

  it("bring the manager the row's line calls: a brew row brings Homebrew and its toolchain, and waits on them", () => {
    const brewRow: RecipeCustomRow = { ...just, id: "brew/just", manager: "brew" };
    const plan = toolInstallsFor([], new Map(), [brewRow]);
    expect(plan.installs.map(t => t.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", `${CUSTOM_PREFIX}brew/just`]);
    // The row waits on the last toolchain step, as a formula on the brew road does.
    expect(plan.installs.at(-1)!.after).toBe("tools/brew-toolchain/gcc");
  });

  it("bring a manager the base does not carry as its own step, and wait on that: a pipx row gets pipx", () => {
    const pipxRow: RecipeCustomRow = { ...ruff, id: "pipx/ruff", manager: "pipx" };
    const plan = toolInstallsFor([], new Map(), [pipxRow]);
    expect(plan.installs.map(t => t.id)).toContain("tools/manager/pipx");
    expect(plan.installs.at(-1)).toMatchObject({ id: `${CUSTOM_PREFIX}pipx/ruff`, after: "tools/manager/pipx" });
  });

  it("wait on nothing when the base already carries the manager, or when the row names none", () => {
    // uv and npm are on every machine from the base, so there is no step to wait on.
    const uvRow: RecipeCustomRow = { ...ruff, id: "uv/ruff", manager: "uv" };
    expect(toolInstallsFor([], new Map(), [uvRow]).installs).toEqual([expect.objectContaining({ id: `${CUSTOM_PREFIX}uv/ruff` })]);
    expect(toolInstallsFor([], new Map(), [uvRow]).installs[0]).not.toHaveProperty("after");
    expect(toolInstallsFor([], new Map(), [just]).installs[0]).not.toHaveProperty("after");
  });

  it("has no plan at all when the recipe carries none", () => {
    expect(toolInstallsFor([], new Map()).installs.filter(t => t.id.startsWith(CUSTOM_PREFIX))).toEqual([]);
  });
});

describe("a recipe's rows outside the catalog in its digest", () => {
  const entries = [row({ id: "tools/brew/fd" })];

  it("pin the golden: adding one, changing its line or dropping it is another golden", () => {
    const none = recipeHash(recipeDigest(entries));
    const one = recipeHash(recipeDigest(entries, [], [just]));
    const other = recipeHash(recipeDigest(entries, [], [{ ...just, install: ["apt-get install -y just"] }]));
    expect(new Set([none, one, other]).size).toBe(3);
    expect(recipeHash(recipeDigest(entries, [], [just, ruff]))).toBe(recipeHash(recipeDigest(entries, [], [ruff, just])));
  });

  it("a check that changed alone is not a change to the machine", () => {
    expect(recipeHash(recipeDigest(entries, [], [just]))).toBe(recipeHash(recipeDigest(entries, [], [{ ...just, check: "just --version" }])));
  });

  it("read as an added, changed or removed tool when a later run is diffed against the golden's own digest", () => {
    const before = recipeDigest(entries, [], [just]);
    const after = recipeDigest(entries, [], [{ ...just, install: ["apt-get install -y just"] }, ruff]);
    expect(diffRecipes(before, after).tools).toEqual([
      { id: "tools/custom/just", label: "just", change: "changed", from: "brew install just", to: "apt-get install -y just" },
      { id: "tools/custom/ruff", label: "ruff", change: "added", to: "uv tool install ruff" },
    ]);
    expect(diffRecipes(after, before).tools.map(t => t.change)).toEqual(["changed", "removed"]);
  });
});

describe("the tools stage on rows outside the catalog", () => {
  it("runs each one alone, names the exact command on the step's frames, and records the outcome by name", async () => {
    const machine = builder();
    const frames: string[] = [];
    const out = await installTools(machine, customInstallsFor([just, ruff]), (_stage, detail, step) => frames.push(step === undefined ? (detail ?? "") : `${detail} [${step.label}: ${step.command}]`));
    expect(out.tools.map(t => ({ label: t.label, outcome: t.outcome }))).toEqual([
      { label: "just", outcome: "installed" },
      { label: "ruff", outcome: "installed" },
    ]);
    expect(frames).toContain("just (1/2) [just: brew install just]");
    expect(frames).toContain("ruff (2/2) [ruff: uv tool install ruff]");
    expect(machine.scripts.filter(s => s.includes("brew install just"))).toHaveLength(1);
    // A row may type any manager's command, so its script opens with every road's network clock and the script road's limit.
    const script = machine.scripts.find(s => s.includes("brew install just"))!;
    expect(script).toMatch(/export npm_config_fetch_timeout=60000 .*\nexport PIP_TIMEOUT=60 .*\nexport UV_HTTP_TIMEOUT=60 .*\nexport CARGO_HTTP_TIMEOUT=60 .*\ncurl\(\) \{ command curl --connect-timeout 15 .*\nexport PATH=/);
    expect(script).toContain("while [ $t -lt 600 ]");
  });

  it("checks each one after its install, and a row whose install exited 0 without leaving the tool is a failure", async () => {
    const machine = builder({ checkFails: "ruff --version" });
    const out = await installTools(machine, customInstallsFor([just, ruff]), () => {});
    expect(out.tools.map(t => t.outcome)).toEqual(["installed", "failed"]);
    expect(out.tools[1]!.note).toBe("the check did not pass (ruff --version): command not found");
    // One run answers for every row, and each check is named in it.
    const runs = machine.inline.filter(c => c.includes("wsp-check"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("command -v just");
    expect(runs[0]).toContain("ruff --version");
  });

  it("reads the checks with one real shell run: the row whose check exits non-zero is the one that fails", async () => {
    // The batched script runs under this machine's bash, so its own shape is proven rather than read: the marker
    // line, the failing check's last line, and the run exiting 0 even when a check did not.
    const machine = builder();
    machine.exec = async cmd => (cmd.includes("wsp-check") ? shellOut(cmd) : { exitCode: 0, stdout: "", stderr: "" });
    const there = { ...just, id: "there", name: "there", check: "true" };
    const gone = { ...ruff, id: "gone", name: "gone", check: "definitely-not-a-command-xyz --version" };
    const out = await installTools(machine, customInstallsFor([there, gone]), () => {});
    expect(out.tools.map(t => ({ label: t.label, outcome: t.outcome }))).toEqual([
      { label: "there", outcome: "installed" },
      { label: "gone", outcome: "failed" },
    ]);
    expect(out.tools[1]!.note).toContain("definitely-not-a-command-xyz: command not found");
  });

  it("says so in the stage detail when the checks could not be run at all, and counts every checked row as failed", async () => {
    const machine = builder({ checksBroken: true });
    const lines: string[] = [];
    const out = await installTools(machine, customInstallsFor([just, ruff]), (_stage, detail) => lines.push(detail ?? ""));
    expect(out.tools.map(t => t.outcome)).toEqual(["failed", "failed"]);
    expect(out.tools[0]!.note).toContain("the check could not be run (command -v just)");
    expect(lines.find(l => l.startsWith("the checks could not be run"))).toContain("just, ruff count as failed");
  });

  it("lets a failed row fail alone: it is named with its reason and the rows after it still install", async () => {
    const machine = builder({ fail: "brew install just" });
    const out = await installTools(machine, customInstallsFor([just, ruff]), () => {});
    expect(out.tools[0]).toMatchObject({ label: "just", outcome: "failed", note: "Error: brew install just is not available" });
    expect(out.tools[1]).toMatchObject({ label: "ruff", outcome: "installed" });
  });
});
