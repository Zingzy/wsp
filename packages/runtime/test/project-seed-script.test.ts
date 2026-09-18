// SPDX-License-Identifier: AGPL-3.0-only
// The script an add runs on the computer, against real git: a bare origin, a
// clone of it with commits the remote does not have, and the seed archive the
// host would pack. Run here rather than answered by a stub, because the two
// shapes that broke it (a branch the remote has never seen, and the remote's
// own default branch two commits behind) are git's own refusals.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SeedChoice, SeedPlan } from "@wsp/protocol";
import { cloneScript } from "../src/project-landing.js";
import { projectSource } from "../src/project-sources.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (at: string, ...args: string[]): string => execFileSync("git", ["-C", at, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

/** A bare origin with one commit on main, and a clone of it: the shape a person's folder is in. */
function originAndClone(): { origin: string; folder: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-seed-script-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const folder = join(root, "spoo-landing");
  execFileSync("git", ["clone", "-q", origin, folder]);
  writeFileSync(join(folder, "README.md"), "one\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-qm", "first");
  git(folder, "push", "-q", "origin", "main");
  return { origin, folder, root };
}

/** The archive the host's pack would have made: the ticked file, the patch of the commits the remote does not
 * have, and the memory folder, at the paths the landing unpacks them from. */
function seedTar(root: string, o: { patch: string; memory?: string }): string {
  const stage = mkdtempSync(join(root, "stage-"));
  mkdirSync(join(stage, ".wsp-seed", "memory"), { recursive: true });
  writeFileSync(join(stage, ".env.local"), "TOKEN=abc\n");
  writeFileSync(join(stage, ".wsp-seed", "commits.patch"), o.patch);
  writeFileSync(join(stage, ".wsp-seed", "memory", "MEMORY.md"), o.memory ?? "- one thing\n");
  const tar = join(root, "seed.tgz");
  execFileSync("tar", ["-czf", tar, "-C", stage, ".env.local", ".wsp-seed"]);
  return tar;
}

function plan(o: { source: string; remote: string; branch: string; base: string; commits: number }): SeedPlan {
  return {
    source: o.source,
    remote: o.remote,
    branch: o.branch,
    defaultBranch: "main",
    unpushed: { commits: o.commits, base: o.base },
    uncommitted: 0,
    memory: { key: "-Users-dev-spoo-landing", files: 1, bytes: 20 },
    files: [{ path: ".env.local", dir: false, bytes: 12, kind: "config", row: { id: "next", name: "Next" }, ticked: true }],
    remembered: false,
  };
}

const CHOICE: SeedChoice = { files: [".env.local"], memory: true, commits: true };

/** The script the box road runs, with the checkout and the memory folder where this test can read them. */
function runScript(o: { root: string; remote: string; checkout: string; memoryDir: string; plan: SeedPlan; seedTar: string }): void {
  const script = cloneScript({
    source: projectSource("git"),
    remote: o.remote,
    checkout: o.checkout,
    computer: "spoo",
    seedTar: o.seedTar,
    seed: { plan: o.plan, choice: CHOICE },
    memoryDir: o.memoryDir,
  });
  execFileSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

describe("the script that clones and seeds a project on a computer", () => {
  it("lands the commits of a branch the remote has never seen as a branch of its own, on top of where they started", () => {
    const { origin, folder, root } = originAndClone();
    // The person's own branch, two commits, none of it pushed.
    git(folder, "checkout", "-qb", "refactor/dashboard-polish");
    for (const n of ["two", "three"]) {
      writeFileSync(join(folder, `${n}.md`), `${n}\n`);
      git(folder, "add", "-A");
      git(folder, "commit", "-qm", n);
    }
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const patch = git(folder, "format-patch", "--stdout", `${base}..HEAD`);
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "memory");
    runScript({ root, remote: origin, checkout, memoryDir, plan: plan({ source: folder, remote: origin, branch: "refactor/dashboard-polish", base, commits: 2 }), seedTar: seedTar(root, { patch }) });
    // The clone came up on the remote's own default branch and is still on it.
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    // Their branch is there, with both commits on top of the commit they started from.
    expect(git(checkout, "log", "--format=%s", "refactor/dashboard-polish", "-3").trim().split("\n")).toEqual(["three", "two", "first"]);
    // The ticked file landed, the memory folder was moved out of the checkout and wsp's own folder is gone.
    expect(readFileSync(join(checkout, ".env.local"), "utf8")).toBe("TOKEN=abc\n");
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- one thing\n");
    expect(existsSync(join(checkout, ".wsp-seed"))).toBe(false);
  });

  it("lands the commits of the remote's own default branch on top of it, where the clone already made that branch", () => {
    const { origin, folder, root } = originAndClone();
    // Two commits on main that were never pushed: the clone makes main itself, so the branch already exists.
    for (const n of ["two", "three"]) {
      writeFileSync(join(folder, `${n}.md`), `${n}\n`);
      git(folder, "add", "-A");
      git(folder, "commit", "-qm", n);
    }
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const patch = git(folder, "format-patch", "--stdout", `${base}..HEAD`);
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "memory");
    runScript({ root, remote: origin, checkout, memoryDir, plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 2 }), seedTar: seedTar(root, { patch }) });
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(checkout, "log", "--format=%s", "-3").trim().split("\n")).toEqual(["three", "two", "first"]);
    expect(existsSync(join(checkout, ".wsp-seed"))).toBe(false);
  });

  it("leaves the memory already standing at the agent's path alone, and says so on its own output", () => {
    const { origin, folder, root } = originAndClone();
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const patch = git(folder, "format-patch", "--stdout", `${base}..HEAD`);
    const checkout = join(root, "checkout");
    // The memory the agent on that computer has kept for this project, which the seed must not write over.
    const memoryDir = join(root, "state", "projects", "-root-spoo-landing", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "- what the agent learned here\n");
    const script = cloneScript({
      source: projectSource("git"),
      remote: origin,
      checkout,
      computer: "spoo",
      seedTar: seedTar(root, { patch, memory: "- what the folder carried\n" }),
      seed: { plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 0 }), choice: { files: [".env.local"], memory: true, commits: false } },
      memoryDir,
    });
    const said = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    // Byte for byte what the agent had, and the mark the landing reads to say the seed's memory was not landed.
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- what the agent learned here\n");
    expect(said).toContain("wsp-memory-kept");
    // And the rest of the seed landed as it always does: the ticked file, and wsp's own folder gone.
    expect(readFileSync(join(checkout, ".env.local"), "utf8")).toBe("TOKEN=abc\n");
    expect(existsSync(join(checkout, ".wsp-seed"))).toBe(false);
  });

  it("lands the seed's memory where nothing stands at all, making the folder above it", () => {
    const { origin, folder, root } = originAndClone();
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const patch = git(folder, "format-patch", "--stdout", `${base}..HEAD`);
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "state", "projects", "-root-spoo-landing", "memory");
    const script = cloneScript({
      source: projectSource("git"),
      remote: origin,
      checkout,
      computer: "spoo",
      seedTar: seedTar(root, { patch, memory: "- what the folder carried\n" }),
      seed: { plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 0 }), choice: { files: [".env.local"], memory: true, commits: false } },
      memoryDir,
    });
    const said = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- what the folder carried\n");
    expect(said).not.toContain("wsp-memory-kept");
  });

  it("clones and seeds with no patch at all where the person kept none", () => {
    const { origin, folder, root } = originAndClone();
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "memory");
    const script = cloneScript({
      source: projectSource("git"),
      remote: origin,
      checkout,
      computer: "spoo",
      seedTar: seedTar(root, { patch: "" }),
      seed: { plan: { ...plan({ source: folder, remote: origin, branch: "main", base: "x", commits: 0 }), unpushed: null }, choice: { files: [".env.local"], memory: true, commits: false } },
      memoryDir,
    });
    execFileSync("sh", ["-c", script]);
    expect(git(checkout, "log", "--format=%s", "-1").trim()).toBe("first");
    expect(readFileSync(join(checkout, ".env.local"), "utf8")).toBe("TOKEN=abc\n");
  });
});
