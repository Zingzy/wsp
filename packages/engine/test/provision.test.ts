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
import { MCP_ID_PREFIX, placeProvisionPaths, provisionCountWord, provisionLines, provisionWord, type PlaceProvisionRow } from "@wsp/protocol";
import { BASE_VERSIONS_CMD } from "../src/golden-base.js";
import { TOOLS_PATH, agentInstallsFor, toolInstallsFor, type RecipeEntry, type ToolInstall } from "../src/golden-import.js";
import { FREE_KB_CMD } from "../src/golden-tools.js";
import { MCP_SERVERS_JSON } from "@wsp/catalog";
import { presentByWhatWaits, presentSteps, provisionBox, provisionCountsOf, provisionPlanOf, type ProvisionPlan } from "../src/provision.js";
import { OLD_APPEND_MARKS, READS_PER_EXEC } from "../src/exec-detached.js";
import { SERVER_MARK } from "../src/provision-files.js";
import { tarOf } from "../src/vault.js";
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
      // What the test says first, then what every box answers: the disk, the floor's versions and the context probe.
      const said = answer(cmd);
      if (said !== undefined) return said;
      if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${9_000_000}\n`, stderr: "" };
      if (cmd === BASE_VERSIONS_CMD) return { exitCode: 0, stdout: `${FLOOR_READ}\n`, stderr: "" };
      if (cmd.includes("echo WSP_CTX")) return { exitCode: 0, stdout: "WSP_CTX\nAGENT claude\nWSP_CTX_END\n", stderr: "" };
      return ok;
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

const planOf = (steps: readonly ToolInstall[], skipped: ProvisionPlan["skipped"] = [], over: Partial<ProvisionPlan> = {}): ProvisionPlan => ({ recipeAt: "2026-09-17T10:00:00.000Z", steps, skipped, ...over });

/** The login the computer's own agent runs as, which is where the agents' folders are there. */
const ON = { home: "/root" };

/** The rows a run answered, as the assertions read them. */
const outcomes = (rows: readonly PlaceProvisionRow[]): [string, string][] => rows.map(r => [r.id, r.outcome]);

/** A recipe row as the planner reads one: ticked, with the id the collector writes. */
const row = (id: string, rung = "agents"): RecipeEntry => ({ rung, id, label: id, paths: [], bytes: 0, default: "bring", bring: true });

/** Every marker a presence read asks for, as a computer that answers every one of them prints them. */
const everyMark = (cmd: string): string =>
  cmd
    .split("\n")
    .flatMap(line => {
      const at = /wsp-present[^0-9]*([0-9]+)/.exec(line);
      return at === null ? [] : [`wsp-present ${at[1]!}`];
    })
    .join("\n");

/** A computer that answers the presence read for the commands named in it and for no others, so a test says which
 * rows the box has rather than which place they fell in a page. */
const marksFor = (cmd: string, wanted: readonly string[]): string =>
  cmd
    .split("\n")
    .flatMap(line => {
      const at = /wsp-present[^0-9]*([0-9]+)/.exec(line);
      return at !== null && wanted.some(w => line.includes(w)) ? [`wsp-present ${at[1]!}`] : [];
    })
    .join("\n");

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
    // Eff is not on the computer at all; the node step names nothing that can be read and is never present.
    expect([...present].sort()).toEqual(["agents/cee", "tools/apt/bee", "tools/custom/ace"]);
  });

  it("is every step of a plan the computer already answers, so a second run of that recipe installs nothing", async () => {
    // The recipe spoo gets: the node step, Claude Code by its own installer, Codex by npm at the version the
    // catalog pins, Homebrew and its toolchain, the shared step and two formulae. Every one of them carries a
    // check or a command, and a box that has been provisioned once answers all of them.
    const plan = provisionPlanOf(
      {
        recipeHash: "h1",
        agents: agentInstallsFor([row("agents/claude"), row("agents/codex")]).installs,
        node: agentInstallsFor([row("agents/codex")]).node!,
        tools: toolInstallsFor([row("tools/brew/gh", "tools"), row("tools/brew/yq", "tools")]).installs,
      },
      "2026-09-17T10:00:00.000Z",
    );
    expect(plan.steps.length).toBeGreaterThan(6);
    // No step of the plan is unreadable: each says either a command it puts on PATH or a check of its own.
    for (const s of plan.steps) expect(s.check ?? s.bin, s.id).toBeDefined();
    const { machine } = boxMachine(cmd => (cmd.includes("wsp-present") ? { exitCode: 0, stdout: everyMark(cmd), stderr: "" } : undefined));
    const rows = await provisionBox(machine, plan, () => {}, ON);
    expect(rows.map(r => r.id)).toEqual(plan.steps.map(s => s.id));
    expect(rows.every(r => r.outcome === "present")).toBe(true);
    expect(provisionWord({ state: "done", addId: "a_1", recipeAt: plan.recipeAt, startedAt: "x", rows })).toBe(`${rows.length} tools ready`);
    expect(provisionLines("spoo", { state: "done", addId: "a_1", recipeAt: plan.recipeAt, startedAt: "x", rows })[0]).toBe(`spoo: nothing installed, ${rows.length} already there`);
  });

  it("is a step whose only read is its version: the version it asks for, or any version at all where it asks for none", async () => {
    const dir = scratch({ bun: "echo 1.4.0", wrangler: "echo 4.105.0", quiet: "exit 0", cloudflared: "echo 2026.9.1" });
    // The three npm rows of spoo's recipe carry no command of their own and no check: what a person asked for is a
    // package at a version, and the road's own version read is the whole of what the computer can be asked.
    const steps = [
      step({ id: "tools/npm/bun", label: "bun@1.4.0", manager: "npm", asks: "1.4.0", pin: { read: "bun", fixed: true, words: "as an npm global" } }),
      step({ id: "tools/npm/wrangler", label: "wrangler@4.106.0", manager: "npm", asks: "4.106.0", pin: { read: "wrangler", fixed: true, words: "as an npm global" } }),
      step({ id: "tools/npm/agent-browser", label: "agent-browser@0.31.1", manager: "npm", asks: "0.31.1", pin: { read: "agent-browser", fixed: true, words: "as an npm global" } }),
      step({ id: "tools/npm/quiet", label: "quiet", manager: "npm", pin: { read: "quiet", fixed: false, words: "as an npm global" } }),
      step({ id: "tools/brew/cloudflared", label: "cloudflared", manager: "brew", pin: { read: "cloudflared", fixed: false, words: "with Homebrew" } }),
    ];
    const present = await presentSteps(shellMachine(dir), steps);
    // bun answers at the version the recipe pins; wrangler answers at another, which is the drift the recipe is
    // there to fix; agent-browser is not on the computer; quiet prints nothing, so nothing says it is there;
    // cloudflared's road installs whatever it serves that day, so any version it prints is that row on the box.
    expect([...present].sort()).toEqual(["tools/brew/cloudflared", "tools/npm/bun"]);
  });

  it("asks one read of a formula's row, since its check and its version read are the same brew list under su", async () => {
    const brew = toolInstallsFor(["bat", "beads", "btop", "dust", "eza", "fzf", "gum", "yq"].map(n => row(`tools/brew/${n}`, "tools"))).installs.filter(s => s.id.startsWith("tools/brew/"));
    expect(brew).toHaveLength(READS_PER_EXEC);
    // The two are one command: the pin read is the check with an awk after it, so asking both asks the box twice
    // for one fact, and a read under su is about a second against the inline exec's own bound.
    for (const s of brew) expect(s.pin!.read!.startsWith(s.check!), s.id).toBe(true);
    const { machine, calls } = boxMachine(cmd => (cmd.includes("wsp-present") ? { exitCode: 0, stdout: everyMark(cmd), stderr: "" } : undefined));
    const present = await presentSteps(machine, brew);
    expect(present.size).toBe(brew.length);
    const reads = calls.filter(c => c.includes("wsp-present"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.split("list --versions").length - 1).toBe(brew.length);
  });

  it("is a step nothing can be asked about when every step waiting on it is already there, and not when one of them is missing", async () => {
    const steps = [
      step({ id: "tools/apt-index", label: "apt index", manager: "apt" }),
      step({ id: "tools/apt/ffmpeg", label: "ffmpeg", manager: "apt", bin: "ffmpeg", after: "tools/apt-index" }),
      step({ id: "tools/apt/ruby", label: "Ruby 3.1 with bundler", manager: "apt", bin: "ruby", after: "tools/apt-index" }),
    ];
    // An index refresh answers no read of its own: what it was for is the rows behind it, and a box that has all
    // of them has nothing for it to do.
    const { machine, calls } = boxMachine(cmd => (cmd.includes("wsp-present") ? { exitCode: 0, stdout: marksFor(cmd, ["ffmpeg", "ruby"]), stderr: "" } : undefined));
    const rows = await provisionBox(machine, planOf(steps), () => {}, ON);
    expect(outcomes(rows)).toEqual([
      ["tools/apt-index", "present"],
      ["tools/apt/ffmpeg", "present"],
      ["tools/apt/ruby", "present"],
    ]);
    expect(calls.some(c => c.includes("install tools/apt-index"))).toBe(false);

    // One of them is not on the box: the index runs, since the row behind it needs it.
    const one = boxMachine(cmd => (cmd.includes("wsp-present") ? { exitCode: 0, stdout: marksFor(cmd, ["ffmpeg"]), stderr: "" } : undefined));
    const again = await provisionBox(one.machine, planOf(steps), () => {}, ON);
    expect(outcomes(again)).toEqual([
      ["tools/apt-index", "installed"],
      ["tools/apt/ffmpeg", "present"],
      ["tools/apt/ruby", "installed"],
    ]);
    expect(one.calls.some(c => c.includes("install tools/apt-index"))).toBe(true);
  });

  it("is the apt index of a real plan and no other step of it, since every other step says a command, a check or a version", async () => {
    // Two apt rows of the catalog: the plan reads the index once, before the first row that waits on it.
    const plan = provisionPlanOf({ recipeHash: "h1", agents: [], tools: toolInstallsFor([row("tools/catalog/ffmpeg", "tools"), row("tools/catalog/ruby", "tools")]).installs }, "2026-09-17T10:00:00.000Z");
    // Through the rule itself rather than a second copy of it here: on a computer where every step's own read
    // answers, the apt index is the one step the dependents rule has anything to say about.
    const byWhatWaits = presentByWhatWaits(plan.steps, new Set(plan.steps.map(s => s.id)));
    expect([...byWhatWaits].map(id => plan.steps.find(s => s.id === id)!.label)).toEqual(["apt index"]);
    const { machine, calls } = boxMachine(cmd => (cmd.includes("wsp-present") ? { exitCode: 0, stdout: marksFor(cmd, ["ffmpeg", "ruby", "bundle", "gem"]), stderr: "" } : undefined));
    const rows = await provisionBox(machine, plan, () => {}, ON);
    expect(rows.every(r => r.outcome === "present")).toBe(true);
    expect(calls.some(c => c.includes("apt-get update"))).toBe(false);
  });

  it("is nothing at all when the computer answers nothing, and asks for nothing when a step says nothing that can be read", async () => {
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
    const rows = await provisionBox(machine, planOf(steps), detail => void seen.push(detail), ON);
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

  it("says the floor's own lines as a person reads them, with no stage id of the image build's in front", async () => {
    // A computer with none of the floor on it: every floor row runs, and what the terminal and the log on that
    // computer read is the row and the tally, not the stage the image build files them under.
    const { machine } = boxMachine(cmd => (cmd === BASE_VERSIONS_CMD ? { exitCode: 0, stdout: "", stderr: "" } : undefined));
    const seen: string[] = [];
    await provisionBox(machine, planOf([step({ id: "agents/codex", label: "Codex", bin: "codex" })]), detail => void seen.push(detail), ON);
    expect(seen.some(l => l.startsWith("deploying-daemon"))).toBe(false);
    expect(seen.some(l => /^jq \(\d+\/\d+\)$/.test(l))).toBe(true);
    expect(seen.some(l => /^\d+ installed.*free$/.test(l))).toBe(true);
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
    }, ON);
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

  it("answers one row per step as the checks left it, so a row whose check failed after its install is failed in the rows and said again", async () => {
    const steps = [
      step({ id: "tools/brew/bat", label: "bat", manager: "brew", check: "brew list --versions bat" }),
      step({ id: "tools/brew/eza", label: "eza", manager: "brew", check: "brew list --versions eza" }),
    ];
    // Homebrew answers that bat is already installed and up to date, and its check then fails: the row is what
    // the check left it, never an installed row in the answer beside a failed one in the tally.
    const { machine } = boxMachine(cmd => {
      if (cmd.includes("wsp-check")) return { exitCode: 0, stdout: "wsp-check 0 Error: The current working directory must be readable to linuxbrew to run brew.\n", stderr: "" };
      return undefined;
    });
    const seen: string[] = [];
    const rows = await provisionBox(machine, planOf(steps), detail => void seen.push(detail), ON);
    expect(rows.map(r => [r.id, r.outcome])).toEqual([
      ["tools/brew/bat", "failed"],
      ["tools/brew/eza", "installed"],
    ]);
    expect(rows[0]!.note).toContain("The current working directory must be readable");
    // What the log on that computer reads says the row twice: as the loop said it, then as the check left it, so
    // the log and the rows the record keeps cannot disagree.
    expect(seen.filter(l => l.startsWith("bat: "))).toEqual(["bat: installed", expect.stringContaining("bat: failed (the check did not pass")]);
    expect(seen.filter(l => l.startsWith("eza: "))).toEqual(["eza: installed"]);
  });

  it("says which row it was on while it runs, and how many of how many", async () => {
    const steps = [step({ id: "agents/codex", label: "Codex" }), step({ id: "tools/release/gh", label: "GitHub CLI" })];
    const { machine } = boxMachine();
    const at: (string | undefined)[] = [];
    await provisionBox(machine, planOf(steps), (_detail, under) => void at.push(under === undefined ? undefined : `${under.index}/${under.of}: ${under.label}`), ON);
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
      }, ON),
    ).rejects.toThrow("spoo is not connected");
    expect(rows.map(r => r.id)).toEqual(["a/one", "a/two"]);
  });
});

describe("the person's own files and their servers, on the same run", () => {
  /** A plan whose files and servers are named, with a pack this computer answers without reading a disk. */
  const withFilesAndServers = (steps: readonly ToolInstall[]): ProvisionPlan =>
    planOf(steps, [], {
      files: {
        lands: [{ id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/skills" }],
        pack: async () => ({ tar: tarOf([{ path: ".claude-cfg/skills/why/SKILL.md", mode: 0o644, content: "why\n" }]), bytes: 1, unpacked: 1, skipped: [], cut: [], silenced: [], macPaths: [] }),
      },
      mcp: {
        agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: ["/root/.claude-cfg/.claude.json"], format: MCP_SERVERS_JSON, keep: ["github"], drop: [] }], aside: [] }],
        guestHome: "/root",
        rewrites: [],
        binDirs: [],
        tools: [],
      },
    });

  it("lands the files after the tools, writes the servers after the files and the machine context after all of it", async () => {
    const { machine, calls } = boxMachine();
    const rows = await provisionBox(machine, withFilesAndServers([step({ id: "agents/codex", label: "Codex", bin: "codex" })]), () => {}, ON);
    const at = (needle: string): number => calls.findIndex(c => c.includes(needle));
    expect(at("install agents/codex")).toBeGreaterThan(-1);
    expect(at("wsp-land")).toBeGreaterThan(at("install agents/codex"));
    expect(at("wsp_mcp_read")).toBeGreaterThan(at("wsp-land"));
    expect(at("echo WSP_CTX")).toBeGreaterThan(at("wsp_mcp_read"));
    // Every row says what it puts there, so the word on the computers row counts them by kind.
    expect(rows.map(r => [r.id, r.kind])).toEqual([
      ["agents/codex", undefined],
      ["files/.claude-cfg/skills", "file"],
      [`${MCP_ID_PREFIX}claude/github`, "server"],
    ]);
    expect(provisionWord({ state: "done", addId: "a_1", recipeAt: "x", startedAt: "y", rows })).toBe("1 tool, 1 file, 1 MCP server ready");
  });

  it("counts the files and the servers in what the job says it is putting there, and in the rows it is on while it runs", async () => {
    const plan = withFilesAndServers([step({ id: "agents/codex", label: "Codex", bin: "codex" })]);
    expect(provisionCountWord(provisionCountsOf(plan))).toBe("1 tool, 1 file, 1 MCP server");
    const { machine } = boxMachine();
    const at: string[] = [];
    await provisionBox(machine, plan, (_detail, under) => {
      if (under !== undefined) at.push(`${under.index}/${under.of}: ${under.label}`);
    }, ON);
    expect(at).toContain("1/3: Codex");
    expect(at).toContain("2/3: your agents' files");
    expect(at).toContain("3/3: MCP servers");
  });

  it("says every path the archive carried failed, with the reason, when the files could not be packed or landed, and goes on with the rest", async () => {
    const plan = withFilesAndServers([step({ id: "agents/codex", label: "Codex", bin: "codex" })]);
    const { machine, calls } = boxMachine();
    const rows = await provisionBox(
      machine,
      { ...plan, files: { lands: plan.files!.lands, pack: () => Promise.reject(new Error("Keychain: user cancelled")) } },
      () => {},
      ON,
    );
    expect(rows.map(r => [r.id, r.outcome, r.note])).toEqual([
      ["agents/codex", "installed", undefined],
      ["files/.claude-cfg/skills", "failed", "Keychain: user cancelled"],
      [`${MCP_ID_PREFIX}claude/github`, "skipped", "the config edit did not run (exit 0)"],
    ]);
    // The machine context still lands: a computer with its tools on and no word of why is worse than the failure.
    expect(calls.some(c => c.includes("echo WSP_CTX"))).toBe(true);
    // Whose a server in an agent's own file is comes off the list beside the job, which is read even where nothing
    // was packed, so a key wsp wrote there before is still wsp's.
    expect(calls.some(c => c.includes(SERVER_MARK))).toBe(true);
  });

  it("reads the list's keys and both copies of the agents' own files between the landing and the close, and writes down the keys it merged", async () => {
    const { machine, calls } = boxMachine();
    await provisionBox(machine, withFilesAndServers([step({ id: "agents/codex", label: "Codex", bin: "codex" })]), () => {}, ON);
    const at = (needle: string): number => calls.findIndex(c => c.includes(needle));
    // The copy that travelled is read out of the job's own folder beside the agent's own file, in one read.
    const read = calls.find(c => c.includes("wsp_mcp_read"))!;
    expect(read).toContain("/root/.claude-cfg/.claude.json");
    expect(read).toContain(`${placeProvisionPaths("/root").staging}/.claude-cfg/.claude.json`);
    expect(at("wsp-land")).toBeLessThan(at("wsp_mcp_read"));
    expect(at(SERVER_MARK)).toBeGreaterThan(at("wsp-land"));
    // The close is last of the three, so the keys the servers step wrote are in the list it folds together.
    expect(at(OLD_APPEND_MARKS)).toBeGreaterThan(at(SERVER_MARK));
  });

  it("asks the computer nothing about files or servers when the recipe names none, and closes its own folder there all the same", async () => {
    const { machine, calls } = boxMachine();
    await provisionBox(machine, planOf([step({ id: "agents/codex", label: "Codex", bin: "codex" })]), () => {}, ON);
    expect(calls.some(c => c.includes("wsp-land") || c.includes("wsp_mcp_read"))).toBe(false);
    // The close is where the job's own folder on that computer is swept, so it runs whether or not this recipe
    // carries a file of the person's; with no landing it leaves the list exactly as it was.
    expect(calls.some(c => c.includes(OLD_APPEND_MARKS))).toBe(true);
  });
});
