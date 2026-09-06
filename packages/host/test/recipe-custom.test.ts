// SPDX-License-Identifier: AGPL-3.0-only
// The rows a recipe carries that the catalog does not: what --add reads, how
// they join a recipe, and the lines they take in its table.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recipe } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cli, type CliIO } from "../src/cli.js";
import { customFromFlags, customTableLines, parsePair, withCustom } from "../src/recipe-custom.js";

const bare: Recipe = { version: 1, at: "2026-09-06T03:00:00Z", histories: [], rows: [] };

describe("wsp recipe --add", () => {
  it("takes <id>=<install command> and checks the command on PATH when nothing else is said", () => {
    expect(customFromFlags({ add: ["just=brew install just"] })).toEqual([
      { kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v 'just'", why: "added by the agent" },
    ]);
  });

  it("takes a check of its own, and a why the agent gives for every row it adds", () => {
    const rows = customFromFlags({ add: ["ruff=uv tool install ruff"], addCheck: ["ruff=ruff --version"], why: "used in wsp" });
    expect(rows[0]).toMatchObject({ check: "ruff --version", why: "used in wsp" });
  });

  it("is repeatable, and a second line under one id is that row's", () => {
    const rows = customFromFlags({ add: ["just=brew install just", "ruff=uv tool install ruff", "just=apt-get install -y just"] });
    expect(rows.map(r => r.id)).toEqual(["just", "ruff"]);
    expect(rows[0]!.install).toEqual(["apt-get install -y just"]);
  });

  it("refuses a spec that is not <id>=<command>, naming what it was given", () => {
    expect(() => customFromFlags({ add: ["just"] })).toThrow('--add takes <id>=<command>, not "just"');
    expect(() => customFromFlags({ add: ["=brew install just"] })).toThrow("--add takes <id>=<command>");
    expect(() => customFromFlags({ add: ["just="] })).toThrow("--add takes <id>=<command>");
  });

  it("refuses a check for an id nobody added, since the command it guards never runs", () => {
    expect(() => customFromFlags({ add: ["just=brew install just"], addCheck: ["ruff=ruff --version"] })).toThrow("--add-check ruff: nothing was added under that id");
  });

  it("keeps the command whole, equals signs and all", () => {
    expect(parsePair("--add", "x=FOO=1 install x")).toEqual({ id: "x", value: "FOO=1 install x" });
  });
});

describe("a recipe's rows outside the catalog", () => {
  it("adds them, and a second add under the same id replaces that row rather than doubling it", () => {
    const once = withCustom(bare, customFromFlags({ add: ["just=brew install just"] }));
    const twice = withCustom(once, customFromFlags({ add: ["just=apt-get install -y just", "ruff=uv tool install ruff"] }));
    expect(twice.custom?.map(r => r.id)).toEqual(["just", "ruff"]);
    expect(twice.custom?.[0]!.install).toEqual(["apt-get install -y just"]);
  });

  it("shows each row in the table with why it is there, its size and the exact command", () => {
    const recipe = withCustom(bare, [
      ...customFromFlags({ add: ["just=brew install just"] }),
      { kind: "custom" as const, id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", size: 2_000_000_000, why: "used in ml" },
    ]);
    const lines = customTableLines(recipe);
    expect(lines[0]).toBe("Rows the catalog does not carry:");
    expect(lines[1]).toContain("id");
    expect(lines[2]).toContain("just");
    expect(lines[2]).toContain("added by the agent");
    expect(lines[2]).toContain("size unknown");
    expect(lines[2]).toContain("brew install just");
    expect(lines[3]).toContain("1.9 GB");
  });

  it("prints nothing when the recipe has none", () => {
    expect(customTableLines(bare)).toEqual([]);
  });
});

describe("the recipe verb's flags", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
  const io = (lines: string[], errors: string[]): CliIO => ({ log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt });

  it("names both flags in the help, and in the recipe verb's own usage", async () => {
    const lines: string[] = [];
    expect(await cli(["--help"], io(lines, []))).toBe(0);
    // recipe parses its own flags, so its words sit with the verb rather than in the shared options block.
    expect(lines.join("\n")).toContain("--add <id>=<command> carries");
    expect(lines.join("\n")).toContain("--add-check <id>=<command> saying it is");
    const usage: string[] = [];
    expect(await cli(["recipe", "--help"], io(usage, []))).toBe(0);
    expect(usage.join("\n")).toContain("[--add <id>=<command>] [--add-check <id>=<command>]");
  });

  it("refuses a spec that is not <id>=<command> before it reads this computer, and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cli-"));
    dirs.push(dir);
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await cli(["recipe", "--out", join(dir, "recipe.json"), "--add", "just"], io(lines, errors))).toBe(1);
    expect(errors[0]).toBe('wsp recipe: --add takes <id>=<command>, not "just"');
    expect(lines).toEqual([]);
  });

  it("writes what --add named into the recipe it mints from this computer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cli-"));
    dirs.push(dir);
    const out = join(dir, "recipe.json");
    expect(await cli(["recipe", "--out", out, "--add", "just=brew install just", "--add-check", "just=just --version"], io([], []))).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).custom).toEqual([
      { kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "just --version", why: "added by the agent" },
    ]);
  }, 60_000);
});
