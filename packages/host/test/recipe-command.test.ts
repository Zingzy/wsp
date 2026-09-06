// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe from a fake computer: what it writes, what it says about each
// agent's history, the two tables it prints, which are the wizard's own, and
// the rows the catalog does not carry under them.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS, CATALOG_TOOLS } from "@wsp/catalog";
import type { Host } from "@wsp/collect";
import { Recipe } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cli, projectFolder } from "../src/cli.js";
import { signInItems, tableItems } from "../src/init-pick.js";
import { applyRecipe, withCatalogAgents } from "../src/init-recipe.js";
import { recipeTable, sizeText, tableLines, totalsLine } from "../src/init-table.js";
import { writeRecipe } from "../src/recipe-command.js";
import { customFromFlags } from "../src/recipe-custom.js";
import { FIXTURE } from "./init-fixture.js";

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

  it("writes the recipe where asked, creating the directory, and prints the agents and the tools as tables", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "state", "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { now: () => new Date("2026-09-06T03:00:00Z") });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
    expect(recipe.rows.find(r => r.id === "claude")).toMatchObject({ on: true, source: { kind: "installed", paths: ["~/.claude/settings.json"], bin: true } });
    expect(lines[0]).toBe("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
    expect(lines).toContain("Claude Code: no history here");
    expect(lines).toContain("Gemini CLI: no reader for its history yet");
    // Two tables, each with its own totals: one row per catalog entry, its tick, why it is here and what it downloads.
    expect(lines).toContain("Agents");
    expect(lines).toContain("Tools");
    const line = (re: RegExp): string => lines.find(l => /^[●○] /.test(l) && re.test(l)) ?? lines.join("\n");
    expect(line(/Claude Code/)).toMatch(/^● {2}Claude Code\s+installed\s+installed here, never used\s+208\.0 MB$/);
    expect(line(/Codex/)).toMatch(/^○ {2}Codex\s+catalog\s+not installed here\s+455\.0 MB$/);
    expect(line(/Node 22/)).toMatch(/^● {2}Node 22 with npm\s+base\s+always on the image\s+250\.0 MB$/);
    expect(line(/Java 21/)).toMatch(/^○ {2}Java 21\s+catalog\s+in the catalog, on request\s+343\.0 MB$/);
    // A row the catalog has never measured says so, instead of being folded into the estimate's unmeasured count.
    expect(line(/GitHub CLI/)).toMatch(/^● {2}GitHub CLI\s+installed\s+installed here, never used\s+size unknown$/);
    expect(lines.filter(l => /^On: /.test(l))).toEqual([expect.stringMatching(/^On: 1 agent, 208\.0 MB$/), expect.stringMatching(/^On: \d+ tools, [\d.]+ MB, \d+ of unknown size$/)]);
    expect(lines.at(-1)).toBe(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  });

  it("with a project folder it says what that folder asked for, which file asked, what the catalog has no row for, and groups those rows first", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { project: PROJ });
    expect(lines).toContain(`Read ${PROJ} for what it needs: pnpm, Go, Docker engine and compose`);
    expect(lines).toContain("  pnpm: pnpm-lock.yaml needs pnpm");
    expect(lines).toContain("  Go: go.mod needs Go");
    expect(lines).toContain("  Docker engine and compose: compose.yaml needs Docker");
    expect(lines).toContain("  not in the catalog: Ruby (Gemfile needs Ruby)");
    // Go is off in the catalog and never used here; the folder's own go.mod ticks it and the table says which file asked.
    expect(recipe.rows.find(r => r.id === "go")).toMatchObject({ on: true, source: { kind: "project", why: "go.mod needs Go" } });
    expect(lines.find(l => /^[●○] {2}Go\s/.test(l))).toMatch(/^● {2}Go\s+project\s+go\.mod needs Go\s+251\.0 MB$/);
    // A floor row the folder also named stays in the base, where it installs whatever anyone ticks.
    expect(lines.find(l => /^[●○] {2}pnpm\s/.test(l))).toMatch(/^● {2}pnpm\s+base\s+always on the image\s/);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
  });

  it("the verb and the wizard's screens draw the same rows from the same function", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-same-"));
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), join(dir, "recipe.json"), l => lines.push(l), { now: () => new Date("2026-09-06T03:00:00Z") });
    for (const [catalog, grouped, noun] of [[CATALOG_AGENTS, false, "agents"], [CATALOG_TOOLS, true, "tools"]] as const) {
      const rows = recipeTable(recipe, catalog);
      const items = tableItems(rows, recipe, FIXTURE, 4, grouped);
      // The screen's rows are the table's rows, in its order, with the same names, ticks and sizes.
      expect(items.map(i => i.id)).toEqual(rows.map(r => r.id));
      expect(items.map(i => i.label)).toEqual(rows.map(r => r.name));
      expect(items.map(i => (typeof i.hint === "object" ? i.hint.text : i.hint))).toEqual(rows.map(sizeText));
      expect(items.filter(i => i.lock === "on").map(i => i.id)).toEqual(rows.filter(r => r.base).map(r => r.id));
      // And the text the verb printed is that same table with its totals under it.
      const at = lines.indexOf(totalsLine(rows, noun));
      expect(lines.slice(at - rows.length, at)).toEqual(tableLines(rows, 1));
    }
  });

  it("carries the rows --add names into the file and shows them in the printout with the exact command", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { add: customFromFlags({ add: ["just=brew install just"] }) });
    expect(recipe.custom).toEqual([{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v 'just'", why: "added by the agent" }]);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom).toEqual(recipe.custom);
    expect(lines).toContain("Rows the catalog does not carry:");
    expect(lines.find(l => l.includes("just"))).toContain("brew install just");
  });

  it("says so and rewrites the file when a recipe already there cannot be read, rather than refusing to run", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    writeFileSync(out, "{ not json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { add: customFromFlags({ add: ["just=brew install just"] }) });
    expect(lines.find(l => l.includes("could not be read"))).toContain("any rows it added are gone");
    expect(recipe.custom?.map(r => r.id)).toEqual(["just"]);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
  });

  it("keeps the rows an earlier run added, so --add adds up across calls", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    await writeRecipe(laptop(), out, () => {}, { add: customFromFlags({ add: ["just=brew install just"] }) });
    const second = await writeRecipe(laptop(), out, () => {}, { add: customFromFlags({ add: ["ruff=uv tool install ruff"] }) });
    expect(second.custom?.map(r => r.id)).toEqual(["just", "ruff"]);
  });

  it("never offers a sign-in for a row outside the catalog: the install is the whole row", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    const recipe = await writeRecipe(laptop(), out, () => {}, { add: customFromFlags({ add: ["gh-enterprise=brew install gh-enterprise"] }) });
    expect(recipe.custom?.[0]).not.toHaveProperty("signIn");
    expect(recipe.rows.some(r => r.id === "gh-enterprise")).toBe(false);
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [] }), recipe)).items.map(i => i.id)).not.toContain("logins/gh-enterprise");
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
