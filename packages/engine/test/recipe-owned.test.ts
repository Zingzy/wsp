// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { RecipeDigest } from "@wsp/protocol";
import { EXEC_BODY_MAX } from "@wsp/protocol";
import { execFits } from "../src/exec-detached.js";
import { ownedFilesScript, parseOwnedFiles, readOwnedFiles, recipeOwnedFiles, recipeWrittenPaths } from "../src/recipe-owned.js";
import type { ExecResult, Machine } from "../src/machine.js";

function reader(answer: ExecResult): { machine: Machine; cmds: string[] } {
  const cmds: string[] = [];
  const machine: Machine = {
    id: "m1", kind: "sandbox", streamUrl: undefined,
    exec: async cmd => {
      cmds.push(cmd);
      return answer;
    },
    run: async () => answer,
    snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
  };
  return { machine, cmds };
}

describe("the recipe's own files", () => {
  it("the written paths are the recipe's dests, each once and in order, and the rows it marks volatile are named apart", () => {
    const recipe: RecipeDigest = {
      ticks: [],
      files: [
        { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d" },
        { id: "agents/claude", path: "~/.claude", dest: ".claude", digest: "d" },
        { id: "logins/claude", path: "~/.claude.json", dest: ".claude.json", digest: "d", volatile: true },
      ],
    };
    expect(recipeWrittenPaths(recipe)).toEqual({ paths: [".claude", ".claude.json", ".zshrc"], volatile: [".claude.json"] });
  });

  it("the manifest a seal records marks every file under a volatile row, so its bytes never stand for a person's edit", async () => {
    const recipe: RecipeDigest = {
      ticks: [],
      files: [
        { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d" },
        { id: "agents/claude", path: "~/.claude/plugins", dest: ".claude/plugins", digest: "d", volatile: true },
      ],
    };
    const { machine } = reader({ exitCode: 0, stdout: `${"a".repeat(64)}  .zshrc\n${"b".repeat(64)}  .claude/plugins/installed_plugins.json\n`, stderr: "" });
    expect(await recipeOwnedFiles(machine, recipe)).toEqual([
      { path: ".claude/plugins/installed_plugins.json", sha256: "b".repeat(64), volatile: true },
      { path: ".zshrc", sha256: "a".repeat(64) },
    ]);
  });

  it("the read runs one command from the home the paths are relative to and a path no longer there is nothing, not an error", async () => {
    const { machine, cmds } = reader({ exitCode: 0, stdout: `${"a".repeat(64)}  .zshrc\n`, stderr: "" });
    expect(await readOwnedFiles(machine, [".zshrc", ".gone"])).toEqual([{ path: ".zshrc", sha256: "a".repeat(64) }]);
    expect(cmds).toEqual([ownedFilesScript("/root", [".zshrc", ".gone"])]);
    expect(cmds[0]).toContain("2>/dev/null");
  });

  it("a home the read cannot reach fails loudly rather than answering an empty list, which would read as a fork that changed everything", async () => {
    const { machine } = reader({ exitCode: 1, stdout: "", stderr: "no such directory" });
    await expect(readOwnedFiles(machine, [".zshrc"])).rejects.toThrow("reading the recipe's files on m1 failed");
    expect(ownedFilesScript("/root", [".zshrc"])).toContain("|| exit 1");
    expect(ownedFilesScript("/root", [".zshrc"])).not.toContain("|| true");
  });

  it("a thousand paths go a page at a time under the one measured exec cap, so the provider refuses none of them with a 413", async () => {
    const paths = Array.from({ length: 1_000 }, (_, i) => `.claude/skills/skill-${i}/SKILL.md`);
    const { machine, cmds } = reader({ exitCode: 0, stdout: "", stderr: "" });
    await readOwnedFiles(machine, paths);
    expect(cmds.length).toBeGreaterThan(1);
    for (const cmd of cmds) expect(execFits(cmd), `${Buffer.byteLength(cmd)} bytes against ${EXEC_BODY_MAX}`).toBe(true);
    expect(paths.filter(p => cmds.filter(c => c.includes(`'${p}'`)).length === 1)).toHaveLength(paths.length);
  });

  it("a name sha256sum had to escape is left out rather than read as a path with a backslash on it", () => {
    const line = `${"a".repeat(64)}  .zshrc`;
    expect(parseOwnedFiles(`\\${line}\n${line}\n\n`)).toEqual([{ path: ".zshrc", sha256: "a".repeat(64) }]);
  });

  it("nothing is asked of the machine when the recipe wrote no file", async () => {
    const { machine, cmds } = reader({ exitCode: 1, stdout: "", stderr: "nope" });
    expect(await readOwnedFiles(machine, [])).toEqual([]);
    expect(cmds).toEqual([]);
  });
});
