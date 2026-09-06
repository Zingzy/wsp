// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@wsp/collect";
import { Recipe } from "@wsp/protocol";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { cli, projectFolder } from "../src/cli.js";
import { writeRecipe } from "../src/recipe-command.js";

const PROJ = "/Users/dev/proj";
/** The project folder the --project runs read: a compose file, a pnpm lock, a go.mod and a Gemfile the catalog has no row for. */
const PROJECT_FILES: Readonly<Record<string, string>> = {
  [`${PROJ}/compose.yaml`]: "services:\n  db:\n    image: postgres\n",
  [`${PROJ}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'\n",
  [`${PROJ}/go.mod`]: "module example.com/x\n",
  [`${PROJ}/Gemfile`]: 'source "https://rubygems.org"\n',
};

/** A laptop with Claude Code and gh on it, one config file, and no session history anywhere. */
function laptop(): Host {
  return {
    platform: "darwin",
    home: "/Users/dev",
    fs: {
      stat: async p => (p === "/Users/dev/.claude/settings.json" || PROJECT_FILES[p] !== undefined ? { kind: "file", bytes: 10 } : undefined),
      list: async () => [],
      readText: async p => PROJECT_FILES[p],
      walk: async () => [],
      async *lines() {},
    },
    exec: { which: async bin => ["claude", "gh", "node"].includes(bin), run: async () => undefined },
  };
}

describe("wsp recipe", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the recipe where asked, creating the directory, and says what decided each tick in names and counts", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "state", "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { now: () => new Date("2026-09-06T03:00:00Z") });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
    expect(recipe.rows.find(r => r.id === "claude")).toMatchObject({ on: true, source: { kind: "installed", paths: ["~/.claude/settings.json"], bin: true } });
    expect(lines[0]).toBe("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
    expect(lines).toContain("Claude Code: no history here");
    expect(lines).toContain("Codex: no history here");
    expect(lines).toContain("Gemini CLI: no reader for its history yet");
    expect(lines).toContain("Hermes Agent: no history here");
    expect(lines).toContain("Agents here: Claude Code");
    const tools = lines.findIndex(l => l.startsWith("Tools on: "));
    expect(lines[tools]).toMatch(/^Tools on: \d+ of \d+$/);
    expect(lines[tools + 1]).toBe("  your project needs: none");
    expect(lines[tools + 2]).toBe("  installed here: Node 22 with npm, GitHub CLI");
    expect(lines[tools + 3]).toBe("  used by your agents: none");
    expect(lines[tools + 4]).toMatch(/^  popular in the catalog: pnpm, uv, Python 3\.12, git, /);
    expect(lines.at(-1)).toBe(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  });

  it("with a project folder it says what that folder asked for, which file asked, what the catalog has no row for, and ticks those rows first", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { project: PROJ });
    expect(lines).toContain(`Read ${PROJ} for what it needs: pnpm, Go, Docker engine and compose`);
    expect(lines).toContain("  pnpm: pnpm-lock.yaml needs pnpm");
    expect(lines).toContain("  Go: go.mod needs Go");
    expect(lines).toContain("  Docker engine and compose: compose.yaml needs Docker");
    expect(lines).toContain("  not in the catalog: Ruby (Gemfile needs Ruby)");
    const tools = lines.findIndex(l => l.startsWith("Tools on: "));
    // The tick lines follow catalog order, as the three beside them do; the line above follows the order the files were read in.
    expect(lines[tools + 1]).toBe("  your project needs: pnpm, Docker engine and compose, Go");
    // Go is off in the catalog and never used here; the project's own go.mod is what ticks it.
    expect(recipe.rows.find(r => r.id === "go")).toMatchObject({ on: true, source: { kind: "project", why: "go.mod needs Go" } });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
  });
});

describe("the --project flag", () => {
  it("resolves a `~/` answer against this computer's home, trims what was typed, and says whether the folder is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-project-flag-"));
    try {
      expect(projectFolder("~/code/app")).toEqual({ path: join(homedir(), "code/app"), exists: false });
      expect(projectFolder(`  ${dir}  `)).toEqual({ path: dir, exists: true });
      expect(projectFolder(`${dir}/nope`)).toEqual({ path: join(dir, "nope"), exists: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wsp recipe stops on a folder that is not there, before it reads this computer or writes anything", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wsp-project-flag-"));
    try {
      const out = join(tmp, "recipe.json");
      const errors: string[] = [];
      const io = { log: () => {}, error: (l: string) => errors.push(l), ask: async () => "no", askSecret: async () => "" };
      expect(await cli(["recipe", "--project", join(tmp, "nope"), "--out", out], io)).toBe(1);
      expect(errors).toEqual([`wsp recipe: no folder at ${join(tmp, "nope")}`]);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
