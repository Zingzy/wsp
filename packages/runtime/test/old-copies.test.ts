// SPDX-License-Identifier: AGPL-3.0-only
// The one move off copies at boot. A record an older build wrote with a copy
// of the project folder goes, and its folder goes only once every commit it
// holds is safe in the project's repo: a copy with changes no commit holds
// stays, a copy whose branches could not be fetched stays, and what stayed is
// listed beside the state and said once. git is real; the copier removes
// what it is asked to, as the daemon binary's verb does.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCopier, LocalBackend } from "@wsp/engine";
import { OLD_COPY_WORDS, type EventUnion, type ProjectCopy } from "@wsp/protocol";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, testPlatform } from "./stub-backend.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

const roots: string[] = [];
afterEach(() => {
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** A host's folder, a project repo on main inside it, and the runtime wiring that serves the state there. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-old-copies-")));
  roots.push(root);
  const project = join(root, "spoo");
  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  git(project, "commit", "-q", "--allow-empty", "-m", "first");
  const removed: { from: string; to: string; road: string }[] = [];
  const copier = {
    ...fakeCopier(),
    async remove(from: string, to: string, road: string) {
      removed.push({ from, to, road });
      if (road === "worktree") git(from, "worktree", "remove", "--force", to);
      else rmSync(to, { recursive: true, force: true });
    },
  };
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier,
  };
  const state = join(root, "state", "state.json");
  const store = memoryStore();
  const boot = (): Runtime => createRuntime({ backend: stubBackend(), store, adapters: {}, local, statePath: state });
  return { root, project, removed, store, boot, kept: join(root, "state", "copies-kept.txt") };
}

/** Writes a record as a build from before folder records did: the project folder's own record with a copy on it. */
async function oldRecord(store: Store, template: Record<string, unknown>, id: string, copy: ProjectCopy): Promise<void> {
  await store.put("workspaces", id, { ...template, id, name: id, copy });
}

const copyOf = (source: string, path: string, road: ProjectCopy["road"]): ProjectCopy => ({ road, path, source, base: "0".repeat(40), branch: "main", carried: "deps-and-config" });

describe("the move off copies at boot", () => {
  it("fetches a clean copy's branches into the project under refs/rescue before it removes it, keeps a changed one, and keeps one whose fetch failed", async () => {
    const w = world();
    const first = w.boot();
    const project = await first.projects.add({ source: w.project });
    const template = (await w.store.get("workspaces", (await first.workspaces.create({ project: project.id, name: "x" })).id)) as Record<string, unknown>;
    await first.close();

    // A clean copy with two commits on a branch the project never had.
    const clean = join(w.root, "spoo-fix-login");
    execFileSync("git", ["clone", "-q", w.project, clean]);
    git(clean, "checkout", "-q", "-b", "feat/x");
    git(clean, "commit", "-q", "--allow-empty", "-m", "one");
    git(clean, "commit", "-q", "--allow-empty", "-m", "two");
    const tip = git(clean, "rev-parse", "HEAD");
    // A copy with a file no commit holds.
    const changed = join(w.root, "spoo-notes");
    execFileSync("git", ["clone", "-q", w.project, changed]);
    writeFileSync(join(changed, "draft.md"), "mine\n");
    // A clean copy whose fetch cannot land: a ref in the project stands where its branches would go.
    const blocked = join(w.root, "spoo-blocked");
    execFileSync("git", ["clone", "-q", w.project, blocked]);
    git(blocked, "commit", "-q", "--allow-empty", "-m", "only here");
    git(w.project, "update-ref", "refs/rescue/spoo-blocked", "HEAD");
    await oldRecord(w.store, template, "ws_clean", copyOf(w.project, clean, "clonefile"));
    await oldRecord(w.store, template, "ws_changed", copyOf(w.project, changed, "clonefile"));
    await oldRecord(w.store, template, "ws_blocked", copyOf(w.project, blocked, "clonefile"));

    const rt = w.boot();
    const heard: EventUnion[] = [];
    rt.events.on("host.notice", e => heard.push(e as EventUnion));
    await rt.workspaces.list();
    await rt.close();

    // One ref per tip the project lacks: HEAD names the branch's own tip, and main is the project's.
    expect(git(w.project, "for-each-ref", "--format=%(refname) %(objectname)", "refs/rescue/spoo-fix-login")).toBe(`refs/rescue/spoo-fix-login/feat/x ${tip}`);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(join(changed, "draft.md"))).toBe(true);
    expect(existsSync(blocked)).toBe(true);
    expect(w.removed).toEqual([{ from: w.project, to: clean, road: "clonefile" }]);
    const lines = readFileSync(w.kept, "utf8").trim().split("\n");
    expect(lines[0]).toBe(`${changed}\t${OLD_COPY_WORDS.changed}`);
    // git's own error, not the hint it prints under it.
    expect(lines[1]).toMatch(new RegExp(`^${blocked}\\t${OLD_COPY_WORDS.fetchFailed("")}(error|fatal): `));
    expect(lines).toHaveLength(2);
    expect(heard).toEqual([expect.objectContaining({ type: "host.notice", message: OLD_COPY_WORDS.kept(2, w.kept) })]);
    // Every old record is gone, and the project folder is where it was.
    const records = await w.store.list("workspaces");
    expect(records.filter(r => (r as { copy?: unknown }).copy !== undefined)).toEqual([]);
    expect(existsSync(join(w.project, ".git"))).toBe(true);

    // A second boot finds nothing to do.
    const again = w.boot();
    const later: EventUnion[] = [];
    again.events.on("host.notice", e => later.push(e as EventUnion));
    await again.workspaces.list();
    await again.close();
    expect(w.removed).toHaveLength(1);
    expect(later).toEqual([]);
  });

  it("keeps only the branches whose tips the project lacks, one ref per tip, and leaves no fetched ref behind", async () => {
    const w = world();
    const first = w.boot();
    const project = await first.projects.add({ source: w.project });
    const template = (await w.store.get("workspaces", (await first.workspaces.create({ project: project.id, name: "x" })).id)) as Record<string, unknown>;
    await first.close();
    git(w.project, "branch", "shipped");
    git(w.project, "tag", "v1");

    // A copy sharing every branch but one: main and shipped are the project's, old sits at a tagged commit, and two
    // branches stand at the one tip nothing in the project holds.
    const copy = join(w.root, "spoo-many");
    execFileSync("git", ["clone", "-q", w.project, copy]);
    git(copy, "branch", "shipped", "origin/shipped");
    git(copy, "branch", "old", "v1");
    git(copy, "checkout", "-q", "-b", "feat/a");
    git(copy, "commit", "-q", "--allow-empty", "-m", "only here");
    git(copy, "branch", "feat/b");
    git(copy, "checkout", "-q", "main");
    const tip = git(copy, "rev-parse", "feat/a");
    // A second copy whose one new tip an earlier rescue already keeps.
    const twin = join(w.root, "spoo-twin");
    execFileSync("git", ["clone", "-q", copy, twin]);
    git(twin, "checkout", "-q", "-b", "feat/a", "origin/feat/a");
    git(w.project, "fetch", "-q", copy, "feat/a:refs/rescue/earlier/feat/a");
    await oldRecord(w.store, template, "ws_many", copyOf(w.project, copy, "clonefile"));
    await oldRecord(w.store, template, "ws_twin", copyOf(w.project, twin, "clonefile"));

    const rt = w.boot();
    await rt.workspaces.list();
    await rt.close();

    const rescued = git(w.project, "for-each-ref", "--format=%(refname) %(objectname)", "refs/rescue").split("\n");
    expect(rescued).toEqual([`refs/rescue/earlier/feat/a ${tip}`]);
    expect(git(w.project, "for-each-ref", "refs/")).not.toContain("incoming");
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(twin)).toBe(false);
  });

  it("keeps a copy's own tip once, under the first branch that names it", async () => {
    const w = world();
    const first = w.boot();
    const project = await first.projects.add({ source: w.project });
    const template = (await w.store.get("workspaces", (await first.workspaces.create({ project: project.id, name: "x" })).id)) as Record<string, unknown>;
    await first.close();
    const copy = join(w.root, "spoo-two");
    execFileSync("git", ["clone", "-q", w.project, copy]);
    git(copy, "checkout", "-q", "-b", "feat/a");
    git(copy, "commit", "-q", "--allow-empty", "-m", "a");
    git(copy, "branch", "feat/b");
    const tip = git(copy, "rev-parse", "HEAD");
    await oldRecord(w.store, template, "ws_two", copyOf(w.project, copy, "clonefile"));

    const rt = w.boot();
    await rt.workspaces.list();
    await rt.close();

    expect(git(w.project, "for-each-ref", "--format=%(refname) %(objectname)", "refs/rescue")).toBe(`refs/rescue/spoo-two/feat/a ${tip}`);
    expect(existsSync(copy)).toBe(false);
  });

  it("keeps a worktree copy's detached commit under refs/rescue and removes the worktree by its own road", async () => {
    const w = world();
    const first = w.boot();
    const project = await first.projects.add({ source: w.project });
    const template = (await w.store.get("workspaces", (await first.workspaces.create({ project: project.id, name: "x" })).id)) as Record<string, unknown>;
    await first.close();
    const tree = join(w.root, "spoo-review");
    git(w.project, "worktree", "add", "-q", "--detach", tree);
    git(tree, "commit", "-q", "--allow-empty", "-m", "on no branch");
    const head = git(tree, "rev-parse", "HEAD");
    await oldRecord(w.store, template, "ws_tree", copyOf(w.project, tree, "worktree"));

    const rt = w.boot();
    await rt.workspaces.list();
    await rt.close();

    expect(git(w.project, "rev-parse", "refs/rescue/spoo-review/HEAD")).toBe(head);
    expect(existsSync(tree)).toBe(false);
    expect(w.removed).toEqual([{ from: w.project, to: tree, road: "worktree" }]);
    expect(existsSync(w.kept)).toBe(false);
  });

  it("saves a clean copy's detached commit, which no branch holds, under refs/rescue before it removes the copy", async () => {
    const w = world();
    const first = w.boot();
    const project = await first.projects.add({ source: w.project });
    const template = (await w.store.get("workspaces", (await first.workspaces.create({ project: project.id, name: "x" })).id)) as Record<string, unknown>;
    await first.close();
    const loose = join(w.root, "spoo-loose");
    execFileSync("git", ["clone", "-q", w.project, loose]);
    git(loose, "checkout", "-q", "--detach");
    git(loose, "commit", "-q", "--allow-empty", "-m", "on no branch");
    const head = git(loose, "rev-parse", "HEAD");
    await oldRecord(w.store, template, "ws_loose", copyOf(w.project, loose, "clonefile"));

    const rt = w.boot();
    await rt.workspaces.list();
    await rt.close();

    expect(git(w.project, "rev-parse", "refs/rescue/spoo-loose/HEAD")).toBe(head);
    expect(existsSync(loose)).toBe(false);
    expect(existsSync(w.kept)).toBe(false);
  });

  it("keeps a clean copy that holds a stash, which no fetch of its branches carries", async () => {
    const w = world();
    const first = w.boot();
    const project = await first.projects.add({ source: w.project });
    const template = (await w.store.get("workspaces", (await first.workspaces.create({ project: project.id, name: "x" })).id)) as Record<string, unknown>;
    await first.close();
    const stashed = join(w.root, "spoo-stashed");
    execFileSync("git", ["clone", "-q", w.project, stashed]);
    writeFileSync(join(stashed, "half.md"), "half done\n");
    git(stashed, "add", "half.md");
    git(stashed, "stash", "push", "-q", "-m", "half");
    expect(git(stashed, "status", "--porcelain")).toBe("");
    await oldRecord(w.store, template, "ws_stashed", copyOf(w.project, stashed, "clonefile"));

    const rt = w.boot();
    await rt.workspaces.list();
    await rt.close();

    expect(existsSync(stashed)).toBe(true);
    expect(git(stashed, "stash", "list")).toContain("half");
    expect(w.removed).toEqual([]);
    expect(readFileSync(w.kept, "utf8")).toBe(`${stashed}\t${OLD_COPY_WORDS.stashed}\n`);
  });

  it("never removes a copy that is the project folder itself or holds it", async () => {
    const w = world();
    const first = w.boot();
    const project = await first.projects.add({ source: w.project });
    const template = (await w.store.get("workspaces", (await first.workspaces.create({ project: project.id, name: "x" })).id)) as Record<string, unknown>;
    await first.close();
    await oldRecord(w.store, template, "ws_self", copyOf(w.project, w.project, "clonefile"));
    await oldRecord(w.store, template, "ws_above", copyOf(w.project, w.root, "clonefile"));

    const rt = w.boot();
    await rt.workspaces.list();
    await rt.close();

    expect(w.removed).toEqual([]);
    expect(existsSync(join(w.project, ".git"))).toBe(true);
    expect(readFileSync(w.kept, "utf8")).toBe(`${w.project}\t${OLD_COPY_WORDS.isProject}\n${w.root}\t${OLD_COPY_WORDS.isProject}\n`);
  });
});
