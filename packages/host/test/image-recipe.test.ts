// SPDX-License-Identifier: AGPL-3.0-only
// The one composition the seal and a copy's build both read: the same rows,
// the same import, the same envs, and the one difference a copy makes, which
// is that every sign-in is skipped because the vault already holds it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "@wsp/collect";
import type { Recipe, SealedImage } from "@wsp/protocol";
import { copyGoldenRecipe, copyRows, planGoldenRecipe } from "../src/image-recipe.js";
import { answeredRows, defaultAnswers, manifestFor } from "../src/init-recipe.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";

/** The laptop the fixture describes, with the files its rows name actually there: the plan reads this computer, so
 * a row whose path is missing plans nothing and the two plans would agree for the wrong reason. */
function laptop(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n");
  writeFileSync(join(home, ".zshrc"), "export PS1='$ '\n");
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(home, ".codex", "auth.json"), '{"token":"not-a-real-token"}\n');
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: not-a-real-token\n");
}

/** The recipe that laptop's seal was planned from: the fixture's own, with Codex on so its login row has a tool, and
 * both sign-ins answered copy, as the screens left them at the seal. A copy's build has to put those answers back to
 * skip itself; a plan that read the record's answers as they stand would carry the person's logins twice. */
const SMALL: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true, signIn: "copy" as const } : r.id === "gh" ? { ...r, signIn: "copy" as const } : r)) };

const RECORD: SealedImage = {
  name: "default",
  version: 1,
  hash: "a".repeat(64),
  recipeHash: "h1",
  recipe: SMALL,
  logins: [{ name: "codex", state: "copied" }],
  sealedAt: "2026-09-12T00:00:00.000Z",
  sealedFrom: "laptop",
  vault: { sha256: "b".repeat(64), bytes: 400, paths: 2, takenAt: "2026-09-12T00:00:00.000Z" },
};

describe("the recipe a copy at another place is built from", () => {
  let dir: string;
  let home: string;
  let statePath: string;
  const readers = () => ({
    collect: async (): Promise<Manifest> => FIXTURE,
    home,
    platform: "linux" as const,
    statePath,
    agentKeys: {},
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-copy-recipe-"));
    home = join(dir, "home");
    statePath = join(dir, "state.json");
    mkdirSync(home, { recursive: true });
    laptop(home);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The seal's own plan for the same laptop and the same recipe, with the sign-ins answered as the screens would
   * leave them: what a copy is measured against. */
  const sealPlan = () => {
    const manifest = manifestFor({ manifest: FIXTURE }, SMALL, statePath);
    const { ticks, choices } = defaultAnswers(manifest, new Map());
    return planGoldenRecipe({ rows: answeredRows(manifest, ticks, choices), small: SMALL, home, platform: "linux", brew: new Map(), secrets: new Map(), agentKeys: {} });
  };

  it("sets every sign-in row to skip and leaves every other row's answer as the record left it", () => {
    const rows = copyRows(FIXTURE, { ...RECORD, recipe: SMALL }, { home, brew: new Map(), statePath });
    const logins = rows.filter(e => e.rung === "logins");
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every(e => e.choice === "skip" && e.bring !== true)).toBe(true);
    // The agents and tools the record's recipe ticks are ticked here, untouched by the sign-ins going.
    const ticked = new Set(rows.filter(e => e.bring).map(e => e.id));
    expect(ticked).toContain("agents/claude");
    expect(ticked).toContain("agents/codex");
    expect(ticked).toContain("tools/brew/gh");
  });

  it("ticks the tool a sign-in needs, even where the record's recipe carries that tool off", () => {
    // The seal ticks gh's row because its login was answered copy; the small recipe records the answer and not the
    // tick, so a copy that read the rows as written would land the login on a machine with no gh on it.
    const withoutTool: Recipe = { ...SMALL, rows: SMALL.rows.map(r => (r.id === "gh" ? { ...r, on: false } : r)) };
    const rows = copyRows(FIXTURE, { ...RECORD, recipe: withoutTool }, { home, brew: new Map(), statePath });
    const ticked = new Set(rows.filter(e => e.bring).map(e => e.id));
    expect(ticked).toContain("tools/brew/gh");
    // The sign-in itself is still skipped: the vault holds it.
    expect(rows.find(e => e.id === "logins/gh")).toMatchObject({ choice: "skip" });
    expect(ticked).not.toContain("logins/gh");
  });

  it("carries the same rows and envs as the seal's own plan, and only the sign-ins differ", async () => {
    const copy = await copyGoldenRecipe(RECORD, readers());
    const seal = sealPlan();
    expect(copy.envs).toEqual(seal.recipe.envs);
    expect(copy.source).toEqual(SMALL);
    const ticksOf = (digest: { ticks: { id: string }[] } | undefined) => (digest?.ticks ?? []).map(t => t.id).filter(id => !id.startsWith("logins/"));
    expect(ticksOf(copy.import?.recipe)).toEqual(ticksOf(seal.import.recipe));
    // The seal carries the sign-in rows it was answered with; the copy carries none, since the vault holds them.
    expect((seal.import.recipe?.ticks ?? []).some(t => t.id.startsWith("logins/"))).toBe(true);
    expect((copy.import?.recipe?.ticks ?? []).some(t => t.id.startsWith("logins/"))).toBe(false);
  });

  it("carries no login's own file off this computer and reads no Keychain for one", async () => {
    const copy = await copyGoldenRecipe(RECORD, readers());
    const files = copy.import?.recipe?.files ?? [];
    // The person's own files and their agents' config travel as they do on the seal; what a sign-in row alone
    // names does not, and neither does any value a Keychain read would have put beside it.
    expect(files.map(f => f.path)).toContain("~/.zshrc");
    expect(files.map(f => f.path)).toContain("~/.claude");
    expect(files.some(f => f.id.startsWith("logins/"))).toBe(false);
    expect(files.some(f => f.path.startsWith("~/.config/gh"))).toBe(false);
    // The same laptop planned by the seal, where the sign-ins were answered copy, does carry them: the difference
    // is the answer this module writes and nothing else.
    const sealed = sealPlan().import.recipe?.files ?? [];
    expect(sealed.some(f => f.id.startsWith("logins/"))).toBe(true);
    expect(sealed.some(f => f.path.startsWith("~/.config/gh"))).toBe(true);
  });

  it("a record sealed without the recipe it was built from has nothing to build a copy from", async () => {
    const { recipe: _recipe, ...bare } = RECORD;
    await expect(copyGoldenRecipe(bare, readers())).rejects.toThrow(/sealed without the recipe/);
  });

  it("reads Homebrew only where a formula row is here, and a brew that will not answer leaves the plan standing", async () => {
    const asked: string[] = [];
    const copy = await copyGoldenRecipe(RECORD, {
      ...readers(),
      brew: async () => {
        asked.push("brew");
        throw new Error("brew is not on this computer");
      },
    });
    // The fixture has formula rows, so it is read; it failed, and the plan stands on the measured table.
    expect(asked).toEqual(["brew"]);
    expect((copy.import?.recipe?.ticks ?? []).map(t => t.id)).toContain("agents/claude");

    asked.length = 0;
    await copyGoldenRecipe(RECORD, {
      ...readers(),
      collect: async () => ({ entries: FIXTURE.entries.filter(e => !e.id.startsWith("tools/brew/")) }),
      brew: async () => {
        asked.push("brew");
        return new Map();
      },
    });
    expect(asked).toEqual([]);
  });
});
