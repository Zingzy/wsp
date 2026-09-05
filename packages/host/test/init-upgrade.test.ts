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

  it("ticked later, a terminal editor with no config plans its install and nothing else; unticked, its uninstall and nothing else", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wsp-upgrade-home-")));
    homes.push(home);
    const vim: ManifestEntry = { rung: "editors", id: "editors/vim", label: "vim, installed", paths: [], bytes: 0, default: "bring", bring: true };
    const importOf = (rows: readonly ManifestEntry[]) => importFor(rows, { home, secrets: new Map(), platform: "darwin" });
    const before = importOf([]);
    const after = importOf([vim]);
    const labelOf = (id: string) => (id === vim.id ? vim.label : id);

    const up = deltaFor(diffRecipes(before.recipe!, after.recipe!, labelOf), before.recipe!, after, [vim], importOf);
    expect(up.import.tools.map(t => [t.id, t.label, t.manager])).toEqual([["editors/vim", "vim", "apt"]]);
    expect(up.import.tools[0]!.cmd).toContain("apt-get install -y -qq vim");
    expect(up.import.files).toBeUndefined();
    expect(up.import.agents).toEqual([]);
    expect(up.import.recipeHash).toBe(after.recipeHash);
    expect(up.removals).toEqual([]);

    const down = deltaFor(diffRecipes(after.recipe!, before.recipe!, labelOf), after.recipe!, before, [], importOf);
    expect(down.import.tools).toEqual([]);
    expect(down.removals).toEqual([{ what: "editor", id: "editors/vim", label: "vim", cmd: expect.stringContaining("apt-get purge -y -qq vim") }]);
  });

  it("one more extension ticked plans the whole list from every ticked extension row", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wsp-upgrade-home-")));
    homes.push(home);
    const ext = (id: string): ManifestEntry => ({ rung: "editors", id: `editors/vscode-ext/${id}`, label: id, paths: [], bytes: 0, default: "skip", bring: true });
    const one = [ext("ms-python.python")];
    const two = [...one, ext("esbenp.prettier-vscode")];
    const importOf = (rows: readonly ManifestEntry[]) => importFor(rows, { home, secrets: new Map(), platform: "darwin" });
    const before = importOf(one);
    const after = importOf(two);
    const delta = deltaFor(diffRecipes(before.recipe!, after.recipe!), before.recipe!, after, two, importOf);
    expect(delta.import.tools.map(t => [t.id, t.label, t.manager])).toEqual([["editors/vscode-ext", "VS Code extension list", "list"]]);
    expect(delta.import.tools[0]!.cmd).toContain(`'ms-python.python' 'esbenp.prettier-vscode' > "$HOME/.vscode-server/extensions.txt"`);
    expect(delta.removals).toEqual([]);
  });
});
