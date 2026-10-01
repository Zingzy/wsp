// SPDX-License-Identifier: AGPL-3.0-only
// The daemon version is cut at landing and carried by no branch: two branches
// off one main that both change the daemon land one after the other with no
// rebase for the record, and main reads N+1 then N+2. Each landing is played on
// a copy of this repo's own daemon tree and protocol record, in a folder of its
// own, and nothing here writes this checkout.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { daemonContentSha } from "../scripts/daemon-content.mjs";
import { CUT_PATHS, cutDaemonVersion, recordOf } from "../scripts/cut-daemon-version.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Commits whatever the tree holds, as a merge, or the squash after a cut, leaves it: the cut reads a clean tree. */
function commitAll(repo: string): void {
  const git = (...args: string[]): void => void execFileSync("git", ["-c", "user.name=cut", "-c", "user.email=cut@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "--no-verify", "-m", "the tree as it stands");
}

/** A repo as the cut reads it, a git checkout of its own: the daemon tree the sha covers and the protocol file that
 * holds the record, committed. */
function repoAt(from = REPO): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-cut-"));
  made.push(dir);
  cpSync(join(from, "daemon"), join(dir, "daemon"), { recursive: true, filter: path => !/[\\/](target|\.git)([\\/]|$)/.test(path) });
  cpSync(join(from, CUT_PATHS.record), join(dir, CUT_PATHS.record));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // Git's housekeeping after a commit can still be writing objects as the case ends, which fails the cleanup on CI.
  execFileSync("git", ["config", "gc.auto", "0"], { cwd: dir });
  commitAll(dir);
  // A branch's checkout carries its own daemon change and its note, and no version: landed first, it is the main
  // the cases play on. On main, and on a branch with no daemon change, the cut does nothing.
  if (from === REPO && cutDaemonVersion(dir, { note: "the branch under test" }).cut) commitAll(dir);
  return dir;
}

/** A branch's own daemon change, merged: one source file of its own, which is all a branch carries now. */
const change = (repo: string, name: string): void => {
  writeFileSync(join(repo, "daemon", "crates", "wsp-daemon", "src", `${name}.rs`), `pub fn ${name}() {}\n`);
  commitAll(repo);
};

const read = (repo: string, path: string): string => readFileSync(join(repo, path), "utf8");
const rustVersion = (repo: string): number => Number(/pub const DAEMON_VERSION: u32 = (\d+);/.exec(read(repo, CUT_PATHS.rust))![1]);
const fixtureVersion = (repo: string): number => (JSON.parse(read(repo, CUT_PATHS.fixture)) as { daemonVersion: number }).daemonVersion;

describe("cutting the daemon version at landing", () => {
  it("lands two branches off one main one after the other as N+1 then N+2, each carrying no version of its own", () => {
    const main = repoAt();
    const n = recordOf(read(main, CUT_PATHS.record)).length;
    expect(rustVersion(main)).toBe(n);
    // Both branches are opened off the same main and touch nothing but their own daemon source.
    const first = repoAt(main);
    change(first, "landed_first");
    expect(cutDaemonVersion(first, { note: "feat(daemon): the first change" })).toEqual({ cut: true, version: n + 1, sha: daemonContentSha(join(first, "daemon")) });
    // The second lands on the main the first left: its merge is its own file, since neither branch wrote the record.
    const second = repoAt(first);
    change(second, "landed_second");
    const cut = cutDaemonVersion(second, { note: "fix: the second change" });
    expect(cut).toEqual({ cut: true, version: n + 2, sha: daemonContentSha(join(second, "daemon")) });
    if (!cut.cut) return;
    const record = recordOf(read(second, CUT_PATHS.record));
    expect(record).toHaveLength(n + 2);
    expect(record.slice(-2)).toEqual([`"${daemonContentSha(join(first, "daemon"))}"`, `"${cut.sha}"`]);
    // The three places the version is read agree, and each landing's note names its version.
    expect([rustVersion(second), fixtureVersion(second)]).toEqual([n + 2, n + 2]);
    expect(read(second, CUT_PATHS.record)).toContain(` * Version ${n + 1}: the first change.`);
    expect(read(second, CUT_PATHS.record)).toContain(` * Version ${n + 2}: the second change. */\nexport const DAEMON_VERSION = DAEMON_CONTENTS.length;`);
  });

  it("cuts nothing on a tree whose daemon did not change, and nothing a second time on one it has cut", () => {
    const main = repoAt();
    const before = read(main, CUT_PATHS.record);
    expect(cutDaemonVersion(main)).toEqual({ cut: false, version: recordOf(before).length });
    expect(read(main, CUT_PATHS.record)).toBe(before);
    change(main, "landed_once");
    expect(cutDaemonVersion(main, { note: "a change" }).cut).toBe(true);
    commitAll(main);
    const cut = [CUT_PATHS.record, CUT_PATHS.rust, CUT_PATHS.fixture].map(path => read(main, path));
    expect(cutDaemonVersion(main).cut).toBe(false);
    expect([CUT_PATHS.record, CUT_PATHS.rust, CUT_PATHS.fixture].map(path => read(main, path))).toEqual(cut);
  });

  it("takes the branch's own note file over the title and removes it, and refuses a change with no note at all", () => {
    const repo = repoAt();
    change(repo, "noted");
    expect(() => cutDaemonVersion(repo)).toThrow(/note/);
    writeFileSync(join(repo, CUT_PATHS.note), "reads each file once.\n");
    commitAll(repo);
    cutDaemonVersion(repo, { note: "the title, which the file outranks" });
    expect(read(repo, CUT_PATHS.record)).toContain(": reads each file once. */");
    expect(existsSync(join(repo, CUT_PATHS.note))).toBe(false);
  });

  it("refuses a tree with anything uncommitted before it reads or writes a file, an untracked one under the hashed paths included", () => {
    const cutFiles = (repo: string): string[] => [CUT_PATHS.record, CUT_PATHS.rust, CUT_PATHS.fixture].map(path => read(repo, path));
    const edited = repoAt();
    change(edited, "committed");
    writeFileSync(join(edited, CUT_PATHS.record), `${read(edited, CUT_PATHS.record)}\n// an edit nobody committed\n`);
    const editedBefore = cutFiles(edited);
    expect(() => cutDaemonVersion(edited, { note: "a change" })).toThrow(/uncommitted[\s\S]*packages\/protocol\/src\/index\.ts/);
    expect(cutFiles(edited)).toEqual(editedBefore);
    // A file the sha would hash that git does not track yet is the landing folding in something nobody reviewed.
    const untracked = repoAt();
    writeFileSync(join(untracked, "daemon", "crates", "wsp-daemon", "src", "stray.rs"), "pub fn stray() {}\n");
    const untrackedBefore = cutFiles(untracked);
    expect(() => cutDaemonVersion(untracked, { note: "a change" })).toThrow(/daemon\/crates\/wsp-daemon\/src\/stray\.rs/);
    expect(cutFiles(untracked)).toEqual(untrackedBefore);
    // A folder that is no checkout at all has no status to read, and is refused the same way.
    const bare = mkdtempSync(join(tmpdir(), "wsp-cut-bare-"));
    made.push(bare);
    expect(() => cutDaemonVersion(bare, { note: "a change" })).toThrow(/git/);
  });

  it("refuses a tree whose version files disagree with the record, which is a branch that still carries a version", () => {
    const repo = repoAt();
    change(repo, "carried");
    writeFileSync(join(repo, CUT_PATHS.rust), read(repo, CUT_PATHS.rust).replace(/pub const DAEMON_VERSION: u32 = \d+;/, "pub const DAEMON_VERSION: u32 = 999;"));
    commitAll(repo);
    expect(() => cutDaemonVersion(repo, { note: "a change" })).toThrow(/999/);
  });
});
