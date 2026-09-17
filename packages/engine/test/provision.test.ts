// SPDX-License-Identifier: AGPL-3.0-only
// The recipe on a computer somebody owns: what it already satisfies, read by a
// real shell, and what the run does on it in what order. The presence read is
// run under bash here rather than matched as text: what it is for is deciding
// whether a command answers and at which version, which only a shell decides.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BASE_FLOOR } from "@wsp/catalog";
import type { PlaceProvisionRow } from "@wsp/protocol";
import { BASE_VERSIONS_CMD } from "../src/golden-base.js";
import { TOOLS_PATH, type ToolInstall } from "../src/golden-import.js";
import { FREE_KB_CMD } from "../src/golden-tools.js";
import { presentSteps, provisionBox, type ProvisionPlan } from "../src/provision.js";
import type { ExecResult, Machine } from "../src/machine.js";

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

/** Every floor row answering at the version its own row pins, so the floor installs nothing and the run under test
 * is the recipe's rows alone. Built off the catalog, never from a list typed here. */
const FLOOR_READ = BASE_FLOOR.flatMap(e => [`VERSION ${e.bin}: ${e.bin} ${e.major === undefined ? "9.9.9" : `${e.major.version}.0`}`, ...(e.brings ?? []).map(b => `VERSION ${b.bin}: 9.9.9`)]).join("\n");

/** A folder on this computer with one script per command a test wants to answer, so a presence read run under bash
 * finds the commands it looks for. */
function scratch(commands: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-present-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(commands)) {
    const at = join(dir, name);
    writeFileSync(at, `#!/bin/sh\n${body}\n`);
    chmodSync(at, 0o755);
  }
  return dir;
}

/** A computer whose execs a real bash answers, with the scratch folder ahead of the tools PATH the read exports:
 * the read is the thing under test, so a shell runs it. */
function shellMachine(dir: string): Machine {
  return {
    id: "spoo",
    kind: "sandbox",
    exec: async (cmd: string) => {
      const res = spawnSync("bash", ["-c", cmd.replaceAll(TOOLS_PATH, `${dir}:${TOOLS_PATH}`)], { encoding: "utf8" });
      return { exitCode: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    },
  } as unknown as Machine;
}

/** A computer that answers every exec and every run from `answer` and records the order it was asked in. */
function boxMachine(answer: (cmd: string) => ExecResult | undefined = () => undefined) {
  const calls: string[] = [];
  const puts: string[] = [];
  const machine = {
    id: "spoo",
    kind: "sandbox",
    exec: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${9_000_000}\n`, stderr: "" };
      if (cmd === BASE_VERSIONS_CMD) return { exitCode: 0, stdout: `${FLOOR_READ}\n`, stderr: "" };
      if (cmd.includes("echo WSP_CTX")) return { exitCode: 0, stdout: "WSP_CTX\nAGENT claude\nWSP_CTX_END\n", stderr: "" };
      return answer(cmd) ?? ok;
    },
    run: async (script: string) => {
      calls.push(script);
      return answer(script) ?? ok;
    },
    putBytes: async (path: string) => void puts.push(path),
  } as unknown as Machine;
  return { machine, calls, puts };
}

const step = (over: Partial<ToolInstall> & Pick<ToolInstall, "id" | "label">): ToolInstall => ({ manager: "script", cmd: `install ${over.id}`, ...over });

const planOf = (steps: readonly ToolInstall[], skipped: ProvisionPlan["skipped"] = []): ProvisionPlan => ({ recipeAt: "2026-09-17T10:00:00.000Z", steps, skipped });

/** The rows a run answered, as the assertions read them. */
const outcomes = (rows: readonly PlaceProvisionRow[]): [string, string][] => rows.map(r => [r.id, r.outcome]);

describe("what a computer already satisfies", () => {
  it("is the step whose check passes, the step whose command answers with no version asked, and the step reading the version it asks for", async () => {
    const dir = scratch({ ace: "exit 0", bee: "exit 0", cee: "echo 1.2.3", dee: "echo 9.9.9" });
    const steps = [
      step({ id: "tools/custom/ace", label: "Ace", check: "ace --version" }),
      step({ id: "tools/apt/bee", label: "Bee", manager: "apt", bin: "bee" }),
      step({ id: "agents/cee", label: "Cee", manager: "npm", bin: "cee", asks: "1.2.3", pin: { read: "cee --version", fixed: true, words: "as an npm global" } }),
      step({ id: "agents/dee", label: "Dee", manager: "npm", bin: "dee", asks: "1.2.3", pin: { read: "dee --version", fixed: true, words: "as an npm global" } }),
      step({ id: "tools/npm/eff", label: "Eff", manager: "npm", bin: "eff", asks: "1.0.0", pin: { read: "eff --version", fixed: true, words: "as an npm global" } }),
      step({ id: "agents/node", label: "Node 22.23.2" }),
    ];
    const present = await presentSteps(shellMachine(dir), steps);
    // Dee answers, but at another version than the recipe asks for, which is the drift the recipe is there to fix;
    // Eff is not on the computer at all; the node step names neither a command nor a check and is never present.
    expect([...present].sort()).toEqual(["agents/cee", "tools/apt/bee", "tools/custom/ace"]);
  });

  it("is nothing at all when the computer answers nothing, and asks for nothing when no step carries a check or a command", async () => {
    const dir = scratch({});
    expect([...(await presentSteps(shellMachine(dir), [step({ id: "tools/apt/bee", label: "Bee", bin: "bee" })]))]).toEqual([]);
    const { machine, calls } = boxMachine();
    expect([...(await presentSteps(machine, [step({ id: "agents/node", label: "Node" })]))]).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the run on the computer itself", () => {
  it("reads the floor first, then what is already there, then the steps, and writes the context last", async () => {
    const steps = [step({ id: "agents/codex", label: "Codex", manager: "npm", bin: "codex" }), step({ id: "tools/release/gh", label: "GitHub CLI", manager: "release", bin: "gh" })];
    const { machine, calls } = boxMachine();
    const seen: string[] = [];
    const rows = await provisionBox(machine, planOf(steps), detail => void seen.push(detail));
    const at = (needle: string): number => calls.findIndex(c => c.includes(needle));
    expect(at(BASE_VERSIONS_CMD)).toBe(0);
    expect(at("wsp-present")).toBeGreaterThan(0);
    expect(at("install agents/codex")).toBeGreaterThan(at("wsp-present"));
    expect(at("install tools/release/gh")).toBeGreaterThan(at("install agents/codex"));
    expect(at("echo WSP_CTX")).toBeGreaterThan(at("install tools/release/gh"));
    expect(outcomes(rows)).toEqual([["agents/codex", "installed"], ["tools/release/gh", "installed"]]);
    expect(seen.at(-1)).toContain("machine context:");
    // The floor's caches are the person's own on a computer they keep: nothing sweeps them.
    expect(calls.some(c => c.includes("rm -rf /root/.npm") || c.includes("apt-get clean"))).toBe(false);
  });

  it("answers one row per step and per row the plan set aside, with the outcome the computer gave each", async () => {
    const steps = [
      step({ id: "agents/node", label: "Node 22.23.2" }),
      step({ id: "agents/claude", label: "Claude Code", bin: "claude", check: "claude --version" }),
      step({ id: "agents/codex", label: "Codex", manager: "npm", bin: "codex", after: "agents/node" }),
      step({ id: "tools/uv/ruff", label: "ruff", manager: "uv", bin: "ruff" }),
    ];
    const aside = [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }];
    // Claude answers already; the node step fails, so what waits on it is skipped with its name.
    const { machine } = boxMachine(cmd => {
      // The read asks only about the steps that carry a check or a command, so the claude step is the first of them.
      if (cmd.includes("wsp-present")) return { exitCode: 0, stdout: "wsp-present 0\n", stderr: "" };
      if (cmd.includes("install agents/node")) return { exitCode: 1, stdout: "", stderr: "Error: nodejs.org answered 404" };
      return undefined;
    });
    const rows: PlaceProvisionRow[] = [];
    const answered = await provisionBox(machine, planOf(steps, aside), (_detail, _at, row) => {
      if (row !== undefined) rows.push(row);
    });
    expect(outcomes(answered)).toEqual([
      ["tools/brew-cask/raycast", "skipped"],
      ["agents/node", "failed"],
      ["agents/claude", "present"],
      ["agents/codex", "skipped"],
      ["tools/uv/ruff", "installed"],
    ]);
    // Every row reached the stage as its outcome landed, in the same order, and the reasons are the plan's and the
    // loop's own rather than a second wording here.
    expect(rows).toEqual(answered);
    expect(answered[0]!.note).toBe("macOS app, no Linux build");
    expect(answered[1]!.note).toContain("nodejs.org answered 404");
    expect(answered[2]!.note).toBeUndefined();
    expect(answered[3]!.note).toBe("Node 22.23.2 did not install");
  });

  it("says which row it was on while it runs, and how many of how many", async () => {
    const steps = [step({ id: "agents/codex", label: "Codex" }), step({ id: "tools/release/gh", label: "GitHub CLI" })];
    const { machine } = boxMachine();
    const at: (string | undefined)[] = [];
    await provisionBox(machine, planOf(steps), (_detail, under) => void at.push(under === undefined ? undefined : `${under.index}/${under.of}: ${under.label}`));
    expect(at.filter(a => a !== undefined)).toContain("1/2: Codex");
    expect(at.filter(a => a !== undefined)).toContain("2/2: GitHub CLI");
    // Nothing is under way while the floor runs and nothing once the last row has landed.
    expect(at[0]).toBeUndefined();
    expect(at.at(-1)).toBeUndefined();
  });

  it("throws the computer's own sentence when it stops answering, with the rows that landed before it already said", async () => {
    const steps = [step({ id: "a/one", label: "One" }), step({ id: "a/two", label: "Two" }), step({ id: "a/three", label: "Three" })];
    let ran = 0;
    const rows: PlaceProvisionRow[] = [];
    const machine = {
      id: "spoo",
      kind: "sandbox",
      exec: async (cmd: string) => {
        if (cmd === BASE_VERSIONS_CMD) return { exitCode: 0, stdout: `${FLOOR_READ}\n`, stderr: "" };
        // The floor's own step is one run, so the link goes while the third of the recipe's rows is going on.
        if (ran >= 4) throw new Error("spoo is not connected");
        if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${9_000_000}\n`, stderr: "" };
        return ok;
      },
      run: async () => {
        ran++;
        return ok;
      },
    } as unknown as Machine;
    await expect(
      provisionBox(machine, planOf(steps), (_detail, _at, row) => {
        if (row !== undefined) rows.push(row);
      }),
    ).rejects.toThrow("spoo is not connected");
    expect(rows.map(r => r.id)).toEqual(["a/one", "a/two"]);
  });
});
