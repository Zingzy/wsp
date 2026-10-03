// SPDX-License-Identifier: AGPL-3.0-only
// What the picks weigh on a box before Set up: the catalog's measured sizes
// for agents and CLIs, the bytes a skill and a folder's history carry, and
// the room a box needs on top, with every row nobody measured counted apart.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPILER_ROW, catalogEntry, sizeBytes } from "@wsp/catalog";
import { RecipeFile } from "@wsp/protocol";
import { cliBytes, estimatePicks, folderBytes, PICKS_SPARE_BYTES } from "../src/pick-sizes.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const size = (id: string): number => sizeBytes(catalogEntry(id)!.size)!;

describe("what the picks weigh on a box", () => {
  it("reads a CLI's size off the catalog where it measured the row, and nothing for a row it did not", () => {
    expect(cliBytes("brew", "gh")).toBe(size("gh"));
    expect(cliBytes("npm", "a-package-nobody-measured")).toBeUndefined();
  });

  it("counts a folder by the history a clone brings and the ignored files it keeps, never its working files", () => {
    const at = mkdtempSync(join(tmpdir(), "wsp-pick-folder-"));
    dirs.push(at);
    mkdirSync(join(at, ".git", "objects"), { recursive: true });
    writeFileSync(join(at, ".git", "objects", "pack"), Buffer.alloc(3000));
    writeFileSync(join(at, "src.ts"), Buffer.alloc(5000));
    writeFileSync(join(at, ".env"), Buffer.alloc(200));
    expect(folderBytes(at, [])).toBe(3000);
    expect(folderBytes(at, [".env"])).toBe(3200);
  });

  it("adds the agents, the CLIs, the compiler where a row needs it, the skills and the folders to the room a box needs, and counts the rows nobody measured", () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-pick-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".claude", "skills", "why"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "why", "SKILL.md"), Buffer.alloc(100));
    const picks = RecipeFile.parse({
      name: "laptop",
      agents: { claude: { signin: "vault" } },
      clis: { gh: { via: "brew" }, nextest: { via: "cargo", needs: [COMPILER_ROW] }, mystery: { via: "npm" } },
      skills: { why: { from: "~/.claude/skills" } },
      plugins: { "lint@acme": {} },
    });
    const sized = estimatePicks(picks, home);
    expect(sized.bytes).toBe(PICKS_SPARE_BYTES + size("claude") + size("gh") + size(COMPILER_ROW) + 100);
    // The two CLIs no build measured and the plugin, whose size is its marketplace's.
    expect(sized.unmeasured).toBe(3);
  });
});
