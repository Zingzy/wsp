// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "@wsp/collect";
import { diffRecipes, type RecipeDiff } from "@wsp/engine";
import { afterEach, describe, expect, it } from "vitest";
import { importFor } from "../src/init-import.js";
import { carryLogins, deltaFor } from "../src/init-upgrade.js";

const diff = (logins: RecipeDiff["logins"]): RecipeDiff => ({ files: [], tools: [], agents: [], logins });

describe("logins an updated version carries", () => {
  it("carries the previous version's outcomes as they were when no login choice moved", () => {
    const previous = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "skipped" as const }];
    expect(carryLogins(previous, diff([]))).toEqual(previous);
  });

  it("a login whose choice moved to copy is rewritten as copied, in place; one not stamped before is appended", () => {
    const previous = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "not-signed-in" as const }];
    const moved = diff([
      { id: "logins/codex", label: "Codex login", from: "machine", to: "copy" },
      { id: "logins/gh", label: "GitHub CLI login", from: "copy", to: "copy" },
      { id: "logins/vercel", label: "Vercel login", from: "machine", to: "copy" },
    ]);
    expect(carryLogins(previous, moved)).toEqual([
      { name: "GitHub CLI login", state: "signed-in" },
      { name: "Codex login", state: "copied" },
      { name: "Vercel login", state: "copied" },
    ]);
  });

  it("a version that carries none stays without any when nothing moved to copy; a copy move alone stamps that row", () => {
    expect(carryLogins(undefined, diff([]))).toBeUndefined();
    expect(carryLogins(undefined, diff([{ id: "logins/gh", label: "GitHub CLI login", from: "machine", to: "copy" }]))).toEqual([{ name: "GitHub CLI login", state: "copied" }]);
  });

  it("a login moved to sign in is left as it was: that road is the rebuild's", () => {
    const previous = [{ name: "GitHub CLI login", state: "signed-in" as const }];
    expect(carryLogins(previous, diff([{ id: "logins/gh", label: "GitHub CLI login", from: "copy", to: "machine" }]))).toEqual(previous);
  });
});

describe("the delta of a binary row", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  it("ticked later, a binary row plans its install and nothing else; unticked, its uninstall and nothing else", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wsp-upgrade-home-")));
    homes.push(home);
    const gh: ManifestEntry = { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: [], bytes: 0, default: "bring", bring: true, linux: "yes" };
    const importOf = (rows: readonly ManifestEntry[]) => importFor(rows, { home, secrets: new Map(), platform: "darwin" });
    const before = importOf([]);
    const after = importOf([gh]);

    const up = deltaFor(diffRecipes(before.recipe!, after.recipe!), before.recipe!, after, [gh], importOf);
    expect(up.import.tools.map(t => t.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/gh"]);
    expect(up.import.tools.at(-1)!.cmd).toContain("brew install gh");
    expect(up.import.files).toBeUndefined();
    expect(up.import.agents).toEqual([]);
    expect(up.import.recipeHash).toBe(after.recipeHash);
    expect(up.removals).toEqual([]);

    const down = deltaFor(diffRecipes(after.recipe!, before.recipe!), after.recipe!, before, [], importOf);
    expect(down.import.tools).toEqual([]);
    expect(down.removals).toEqual([{ what: "tool", id: "tools/brew/gh", label: "gh", cmd: expect.stringContaining("brew uninstall gh") }]);
  });
});
