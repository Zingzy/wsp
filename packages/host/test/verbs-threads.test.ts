// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { homeShortened, localWorktreeRefusal, threadDeletedLine, HERE_PLACE_ID, askingLine, type PermissionAsk, PERMISSION_ALLOW, effortsFor, EXIT_CODES, markedDefault, noThreadTargetLine, threadForgetRefusal, threadOpenedLine, threadWithoutIdRefusal, ThreadView, thisComputer, type HarnessCatalogAnswer, BUILT_IN_LIST_CLAUSE, BUILT_IN_TABLE_CLAUSE } from "@wsp/protocol";
import { harnessCatalog } from "@wsp/runtime";
import { describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli.js";
import { CLI_VERBS, dialHost, threadRows } from "../src/verbs.js";
import { hostPlatform } from "../src/verbs.js";
import { guestAnswer, withDaemonRoads } from "./stub-backend.js";
import { projectOn, UNREACHED_LINE, bornDeadAgent, captured, heldAgent, projectBundler } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";
import { PROBE_CMD, probing, verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host: threads, projects and agent defaults", () => {
  const h = verbsHost();

  it("thread forget drops the row a launch that never got going left, and refuses a thread whose turn did work and a row from before threads", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    const junk = (await h.rt.sessions.list())[0]!.threadId!;
    expect((await h.run("threads")).io.lines[0]).toContain(junk);

    const forgot = await h.run("thread", "forget", junk.slice(0, 8));
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot thread ${junk}: no turn ever ran on it, so nothing of its work is gone`]);
    expect((await h.run("threads")).io.lines[0]).not.toContain(junk);
    expect(await h.rt.sessions.list()).toEqual([]);

    // The next launch works, so its thread is one a turn ran on: the runtime's own sentence comes back.
    await h.run("run", "alpha", "build it");
    const ran = (await h.rt.sessions.list())[0]!.threadId!;
    const refused = await h.run("thread", "forget", ran);
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp thread forget: ${threadForgetRefusal(ran)}`]);
    expect((await h.rt.sessions.list()).map(r => r.threadId)).toEqual([ran]);

    const missing = await h.run("thread", "forget", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread forget: no thread nope"]);
    // A turn from before threads folds under its own id and no thread here answers to it; the verb says that
    // rather than dialling for a thread nobody has, which is the guard the app's row makes.
    const alpha = (await h.rt.workspaces.list())[0]!.id;
    await h.store.put("sessions", alpha, { workspaceId: alpha, sessions: [{ id: "s_old", workspaceId: alpha, harness: "claude", status: "failed", prompt: "from before threads" }] });
    await h.restartHost({ claude: agent.adapter });
    const before = await h.run("thread", "forget", "s_old");
    expect(before.code).toBe(1);
    expect(before.io.errors).toEqual([`wsp thread forget: ${threadWithoutIdRefusal("s_old")}`]);
    const none = await h.run("thread", "forget");
    expect(none.code).toBe(3);
    expect(none.io.errors).toEqual(["wsp thread forget takes one thread. usage: wsp thread forget <thread>"]);
  });

  it("threads is the sidebar's data: one row per thread with its folder and branch, agent, state and who opened it, within one project or machine when named", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    const [alpha, beta] = await h.rt.workspaces.list();
    await h.rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    await h.run("run", "alpha", "first task");
    await (await h.rt.sessions.start(beta!.id, { prompt: "from the app", harness: "codex" })).finished;
    const { code, io } = await h.run("threads");
    expect(code).toBe(0);
    const rows = io.lines[0]!.split("\n");
    expect(rows[0]).toMatch(/^PROJECT\s+FOLDER\s+BRANCH\s+THREAD\s+TASK\s+AGENT\s+STATE\s+BY\s+COMPUTER\s+TITLE$/);
    const [a] = await h.rt.sessions.list(alpha!.id);
    const [b] = await h.rt.sessions.list(beta!.id);
    // Each row reads project, the folder the thread works in, its branch (none on a machine whose checkout the record
    // does not name, an empty cell the split folds away), thread, agent, state, who opened it, the computer and the
    // title. Both turns ended and no window has shown either, so both read Done, the word the app's tile shows.
    expect(rows.slice(1).map(r => r.split(/ {2,}/))).toEqual([
      [alpha!.project.name, alpha!.project.path, a!.threadId!, "claude", "Done", "cli", alpha!.project.computer, "first task"],
      [beta!.project.name, beta!.project.path, b!.threadId!, "codex", "Done", "person", beta!.project.computer, "from the app"],
    ]);
    // A window showing one moves its stamp on the host, and so does reading it here; both read Idle at once.
    await h.rt.sessions.read(b!.threadId!);
    const read = await h.run("threads");
    expect(read.io.lines[0]!.split("\n").slice(1).map(r => r.split(/ {2,}/)[4])).toEqual(["Done", "Idle"]);
    expect((await h.run("thread", "read", a!.threadId!)).code).toBe(0);
    const both = await h.run("threads");
    expect(both.io.lines[0]!.split("\n").slice(1).map(r => r.split(/ {2,}/)[4])).toEqual(["Idle", "Idle"]);

    const scoped = await h.run("threads", "beta", "--json");
    expect(scoped.code).toBe(0);
    const [{ threads }] = h.json(scoped.io) as [{ threads: (ThreadView & { folder: string; branch: string; projectName: string; computerName: string })[] }];
    // The rows the tool answers with: the sidebar's view plus the names the table shows beside it.
    const bare = ({ folder: _f, branch: _b, projectName: _p, computerName: _c, ...t }: (typeof threads)[number]) => t;
    expect(threads.map(t => ThreadView.parse(bare(t)))).toEqual(threads.map(bare));
    expect(threads).toEqual([
      expect.objectContaining({ id: b!.threadId, workspaceId: beta!.id, folder: beta!.project.path, branch: "", projectName: beta!.project.name, computerName: beta!.project.computer, harness: "codex", startedBy: "person", turns: 1 }),
    ]);
  });

  it("threads reads a thread stopped on a permission prompt as needing the person, and as working again once it is answered", async () => {
    const ASKED: PermissionAsk = { askId: "ask_1", toolName: "Write", detail: "out.txt", input: '{"file_path":"/root/out.txt"}', options: [{ id: PERMISSION_ALLOW, label: "Allow", effect: "allow" }] };
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const started = h.starting("run", "alpha", "write the file");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const working = await h.run("threads");
    expect(working.io.lines[0]!.split("\n")[1]).toContain("Working");

    held.ask(0, ASKED);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(ASKED)));
    const waiting = await h.run("threads");
    expect(waiting.io.lines[0]!.split("\n")[1]).toContain("Needs you");

    held.release(0, "written");
    expect(await started.ended).toBe(0);
    const after = await h.run("threads");
    expect(after.io.lines[0]!.split("\n")[1]).toContain("Done");
  });

  it("run --cwd is the folder the turn starts in, the same field the app's composer sends; without it the workspace's project folder, else none and the harness starts in its own home", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const picked = await h.run("run", "alpha", "--agent", "codex", "--cwd", "/root/work/elsewhere", "write tests");
    expect(picked.code).toBe(0);
    expect(h.codex.starts.map(s => s.cwd)).toEqual(["/root/work/elsewhere"]);

    const bare = await h.run("run", "alpha", "--agent", "claude", "hello");
    expect(bare.code).toBe(0);
    // No folder named: the thread opens in the workspace's project, which is what the workspace is a copy for.
    expect(h.claude.starts.map(s => s.cwd)).toEqual([alpha!.project.path]);
    const rows = await h.rt.sessions.list(alpha!.id);
    expect(rows.map(r => r.cwd)).toEqual(["/root/work/elsewhere", alpha!.project.path]);
    // A line that names no agent runs the one the last thread on this project used.
    expect((await h.run("run", "alpha", "again")).code).toBe(0);
    expect(h.claude.starts).toHaveLength(2);
  });

  it("run with no folder named starts the thread in the workspace's project, and --cwd wins over it", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const named = await h.run("run", "alpha", "build it");
    expect(named.code).toBe(0);
    expect(named.io.errors).toEqual([]);
    expect(h.claude.starts.map(s => s.cwd)).toEqual([alpha!.project.path]);
    const both = await h.run("run", "alpha", "--cwd", "/root/elsewhere", "build it");
    expect(both.code).toBe(0);
    expect(h.claude.starts.at(-1)!.cwd).toBe("/root/elsewhere");
    // The workspace is where the last thread went, which is what a run from nowhere takes.
    expect((await h.rt.preferences.get()).target).toEqual({ workspace: alpha!.id });
  });

  it("run names a project here and the thread runs in its folder, or in a worktree for --branch; from inside a project's folder it goes to that project and says so; outside every project it is refused in one line and nothing starts", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-repo-")));
    execFileSync("git", ["init", "-q", "-b", "main", folder]);
    execFileSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    mkdirSync(join(folder, "packages", "api"), { recursive: true });
    const project = await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "spoo" });
    await h.run("new", h.cloud.name, "beta");
    const named = await h.run("run", "spoo", "hello in the folder");
    expect(named.code, named.io.errors.join("\n")).toBe(0);
    expect(h.claude.starts.at(-1)!.cwd).toBe(folder);
    expect(named.io.lines[0]!.startsWith(threadOpenedLine((await h.rt.sessions.list()).find(t => t.prompt === "hello in the folder")!.threadId!, "spoo", homeShortened(folder, homedir())))).toBe(true);
    // Another branch runs in the worktree the host makes for it, under its own folder.
    const branched = await h.run("run", "spoo", "--branch", "feat/x", "hello on a branch");
    expect(branched.code, branched.io.errors.join("\n")).toBe(0);
    expect(h.copier.worktrees.map(w => ({ from: w.from, project: w.project, branch: w.branch }))).toEqual([{ from: folder, project: project.id, branch: "feat/x" }]);
    const tree = join(dirname(h.statePath), "worktrees", project.id, "feat-x");
    expect(h.claude.starts.at(-1)!.cwd).toBe(tree);
    // The threads table names the folder and the branch each thread works in.
    const rows = await threadRows(await dialHost(h.statePath));
    expect(rows.filter(t => t.projectName === "spoo").map(t => [t.folder, t.branch])).toEqual(
      expect.arrayContaining([
        [folder, "main"],
        [tree, "feat/x"],
      ]),
    );
    const cwd = vi.spyOn(process, "cwd");
    try {
      cwd.mockReturnValue(join(folder, "packages", "api"));
      const inferred = await h.run("run", "hello from the repo");
      expect(inferred.io.errors).toEqual([]);
      expect(inferred.code).toBe(0);
      expect(h.claude.starts.at(-1)!.cwd).toBe(folder);
      // A box's machine named on the line still takes the thread.
      const boxed = await h.run("run", "beta", "--agent", "claude", "named anyway");
      expect(boxed.code, boxed.io.errors.join("\n")).toBe(0);
      expect((await h.rt.sessions.list()).find(t => t.prompt === "named anyway")!.workspaceId).toBe((await h.rt.workspaces.list()).find(w => w.name === "beta")!.id);
      const before = (await h.rt.sessions.list()).length;
      cwd.mockReturnValue(join(h.dir, "code"));
      const nowhere = await h.run("run", "nowhere to go");
      expect(nowhere.code).toBe(EXIT_CODES.usage);
      expect(nowhere.io.errors[0]).toContain(noThreadTargetLine("<project>"));
      expect((await h.rt.sessions.list()).length).toBe(before);
    } finally {
      cwd.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("delete names a thread first: a thread in the project folder goes alone and the folder stays, a thread in a worktree wsp made takes the worktree with it", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-repo-")));
    execFileSync("git", ["init", "-q", "-b", "main", folder]);
    execFileSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "spoo" });
    expect((await h.run("run", "spoo", "first")).code).toBe(0);
    expect((await h.run("run", "spoo", "second")).code).toBe(0);
    const listed = await h.rt.sessions.list();
    const first = listed.find(t => t.prompt === "first")!.threadId!;
    const second = listed.find(t => t.prompt === "second")!.threadId!;
    const gone = await h.run("delete", first.slice(0, 8), "--yes");
    expect(gone.code, gone.io.errors.join("\n")).toBe(0);
    expect(gone.io.lines).toEqual([`deleted thread ${first}`]);
    expect((await h.rt.sessions.list()).map(t => t.threadId)).toEqual([second]);
    expect(existsSync(join(folder, ".git"))).toBe(true);
    expect((await h.run("run", "spoo", "--branch", "feat/y", "on a branch")).code).toBe(0);
    const branched = (await h.rt.sessions.list()).find(t => t.prompt === "on a branch")!.threadId!;
    const tree = (await h.rt.workspaces.list()).find(w => w.worktree !== undefined)!.worktree!.path;
    // The stand-in copier makes a plain folder, so git is put there as the real verb's worktree would have it.
    execFileSync("git", ["init", "-q", tree]);
    // The worktree's record is never named to the person: naming it to delete points at the worktree's own roads.
    const named = await h.run("delete", "spoo@feat/y", "--yes");
    expect(named.code).toBe(3);
    expect(named.io.errors[0]).toContain(localWorktreeRefusal("spoo@feat/y"));
    const took = await h.run("delete", branched, "--yes");
    expect(took.code, took.io.errors.join("\n")).toBe(0);
    expect(took.io.lines).toEqual([threadDeletedLine(branched, { worktree: tree, threads: 1 })]);
    expect(h.copier.worktreesRemoved.map(r => r.path)).toEqual([tree]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("projects lists every project this host holds, each on its computer, with how many threads each has", async () => {
    const spoo = await projectOn(h.rt, undefined, "https://github.com/dev/spoo.git");
    await h.run("new", spoo.name, "alpha");
    const listed = await h.run("projects");
    expect(listed.code).toBe(0);
    expect(listed.io.errors).toEqual([]);
    const [heading, ...rows] = listed.io.lines[0]!.split("\n");
    expect(heading!.split(/ {2,}/)).toEqual(["PROJECT", "ID", "COMPUTER", "SOURCE", "PATH", "BASE", "THREADS", "NEW THREADS"]);
    expect(rows.map(r => r.split(/ {2,}/)).find(r => r[0] === "spoo")).toEqual(["spoo", spoo.id, spoo.computer, "https://github.com/dev/spoo.git", "/root/spoo", "0", "claude claude-opus-5-5 full"]);

    // The computer's own word, never the place id: a project on the computer the host runs on reads as that
    // computer's own word, the same one the workspaces table gives its row.
    const folder = realpathSync(mkdtempSync(join(h.dir, "repo-here-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await projectOn(h.rt, HERE_PLACE_ID, folder);
    const both = await h.run("projects");
    const cell = both.io.lines[0]!.split("\n").map(r => r.split(/ {2,}/)).find(r => r[0] === here.name)!;
    // The host's own platform word: this Mac where the host runs on one, this computer on a Linux runner.
    expect(cell[2]).toBe(thisComputer(hostPlatform()));
    expect(cell[2]).not.toBe(HERE_PLACE_ID);
    const raw = await h.run("projects", "--json");
    expect((h.json(raw.io)[0] as { projects: { name: string }[] }).projects.map(p => p.name)).toContain("spoo");

    // The verb takes no positional: the projects are the host's, not a workspace's.
    const extra = await h.run("projects", "nope");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors[0]).toMatch(/^wsp projects takes no positional arguments/);
  });

  it.runIf(CLOUD_ON)("fork --send --cwd starts the first thread in that folder; without it, in the project the fork holds", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    withDaemonRoads(h.backend);
    const picked = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--cwd", "/root/work/site");
    expect(picked.code).toBe(0);
    expect(h.claude.starts.map(s => s.cwd)).toEqual(["/root/work/site"]);

    const plain = await h.run("fork", "alpha", "--name", "other", "--send", "build it");
    expect(plain.code).toBe(0);
    // A fork is a workspace of the same project, so its first thread opens in that project's folder.
    expect(h.claude.starts.map(s => s.cwd)).toEqual(["/root/work/site", alpha!.project.path]);
    const other = (await h.rt.workspaces.list()).find(w => w.name === "other")!;
    expect(other.project.id).toBe(alpha!.project.id);
  });

  it.runIf(CLOUD_ON)("--model, --effort and --access on run, fork --send and send reach the start as the fields the composer sends; a new thread without them runs the catalog's defaults, the ones the composer shows", async () => {
    await h.run("new", "alpha");
    const picked = await h.run("run", "alpha", "--model", "claude-sonnet-5", "--effort", "low", "--access", "auto-edit", "review it");
    expect(picked.code).toBe(0);
    expect(h.claude.starts.map(s => [s.model, s.effort, s.permissionMode])).toEqual([["claude-sonnet-5", "low", "acceptEdits"]]);

    const bare = await h.run("run", "alpha", "hello");
    expect(bare.code).toBe(0);
    const shown = markedDefault(harnessCatalog("claude")!.models)!.value;
    expect(shown).toBe("claude-opus-5-5");
    const level = markedDefault(effortsFor(harnessCatalog("claude")!, markedDefault(harnessCatalog("claude")!.models) ?? null))!.value;
    expect(h.claude.starts.at(-1)).toMatchObject({ model: shown, effort: level });
    // The access is named too, and named explicitly: an unnamed one reached the adapter as nothing, which every
    // adapter here reads as its own skip-everything flag, so the picker's word and the CLI's flag could differ. It
    // is read off the workspace's own catalog, the list the composer draws, since which mode a start with no flag
    // runs at belongs to the kind of workspace the thread is on.
    const [alpha] = await h.rt.workspaces.list();
    const access = markedDefault((await h.rt.harnesses.list(alpha!.id)).find(c => c.harness === "claude")!.permissionModes)!.value;
    expect(access).toBe("bypassPermissions");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe(access);
    const [, thread] = await h.rt.sessions.list();

    const same = await h.run("send", thread!.threadId!, "go on");
    expect(same.code).toBe(0);
    // A send that names nothing keeps the thread's own access, model and effort rather than the adapter's defaults.
    expect(h.claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, permissionMode: access, model: shown, effort: level });
    const changed = await h.run("send", thread!.threadId!, "--model", "claude-fable-5-1", "--effort", "max", "now think");
    expect(changed.code).toBe(0);
    // The access is not among them: the thread keeps its own, whichever door the message came through.
    expect(h.claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, model: "claude-fable-5-1", effort: "max", permissionMode: access });
    const named = await h.run("send", thread!.threadId!, "--access", "acceptEdits", "and now");
    expect(named.code).toBe(3);
    expect(named.io.errors).toEqual(['--access belongs to wsp agents set, wsp projects set, wsp fork, wsp start and wsp run; wsp send does not read it. usage: wsp send <thread> [--model, --effort <value>] [--fast] [--file <path>] [--detach] "<message>"']);

    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--model", "claude-sonnet-5", "--access", "full");
    expect(forked.code).toBe(0);
    expect(h.claude.starts.at(-1)).toMatchObject({ model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: level });
  });

  it("a thread on this computer runs every action without asking when the line names no access, and at wsp's word when it names one", async () => {
    await h.macProject("mac");
    const bare = await h.run("run", "mac", "write the notes");
    expect(bare.code).toBe(0);
    // The owner's word for his own computer: a thread here does what a session he starts in his own terminal does.
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("bypassPermissions");
    const picked = await h.run("run", "mac", "--access", "auto-edit", "edit the notes");
    expect(picked.code).toBe(0);
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("acceptEdits");
    // One vocabulary on every agent: a harness's own spelling is no word of it, and a word the agent maps to none of
    // its modes is refused naming the ones it takes, never run looser.
    const slug = await h.run("run", "mac", "--access", "acceptEdits", "edit the notes");
    expect(slug.code).toBe(3);
    expect(slug.io.errors[0]).toBe("wsp run: --access takes ask, auto-edit, full or plan, and got acceptEdits. Name one of those; which of its own modes each one is, is the agent's row's to say.");
    const plan = await h.run("run", "mac", "--access", "plan", "read the notes");
    expect(plan.code).toBe(3);
    expect(plan.io.errors[0]).toBe("wsp run: Claude Code takes no plan access; it takes ask, auto-edit, full. Name one it takes, or drop --access.");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("acceptEdits");
    // The command line reads it off the same catalog the app's composer draws, so neither holds a default of its own.
    const [mac] = await h.rt.workspaces.list();
    const shown = (await h.rt.harnesses.list(mac!.id)).find(c => c.harness === "claude")!;
    expect(markedDefault(shown.permissionModes)?.value).toBe("bypassPermissions");
  });

  it("an agent's defaults and its project's override decide what a thread the line names nothing for starts at, and the line's own word wins", async () => {
    await h.macProject("mac");
    const [mac] = await h.rt.workspaces.list();
    const project = (await h.rt.projects.list()).find(p => p.id === mac!.project.id)!;
    expect((await h.run("agents", "set", "claude", "--access", "ask")).code).toBe(0);
    expect((await h.run("run", "mac", "run echo hi")).code).toBe(0);
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("default");
    expect((await h.run("projects", "set", project.name, "--access", "full")).code).toBe(0);
    await h.run("run", "mac", "go on");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("bypassPermissions");
    await h.run("run", "mac", "--access", "auto-edit", "go on");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("acceptEdits");
    // A word the agent maps to none of its modes is refused at the set, as usage, and nothing is kept.
    const plan = await h.run("agents", "set", "claude", "--access", "plan");
    expect(plan.code).toBe(3);
    expect(plan.io.errors).toEqual(["wsp agents set: Claude Code takes no plan access; it takes ask, auto-edit, full"]);
    expect((await h.rt.preferences.get()).agentDefaults["claude"]).toEqual({ access: "ask" });
    const nothing = await h.run("agents", "set", "claude");
    expect(nothing.code).toBe(3);
  });

  it("the default agent runs a thread that names none, its project's agent over it, and wsp projects --json says where each value came from", async () => {
    await h.macProject("mac");
    const [mac] = await h.rt.workspaces.list();
    const project = (await h.rt.projects.list()).find(p => p.id === mac!.project.id)!;
    expect((await h.run("agents", "default", "codex")).code).toBe(0);
    const before = h.codex.starts.length;
    expect((await h.run("run", "mac", "say hi")).code).toBe(0);
    expect(h.codex.starts.length).toBe(before + 1);
    const set = await h.run("projects", "set", project.name, "--agent", "claude", "--json");
    expect(set.code).toBe(0);
    expect(h.json(set.io).at(-1)).toMatchObject({ project: { id: project.id }, defaults: { agent: { value: "claude", from: "project" } } });
    const ran = h.claude.starts.length;
    await h.run("run", "mac", "say hi");
    expect(h.claude.starts.length).toBe(ran + 1);
    const listed = h.json((await h.run("projects", "--json")).io).at(-1) as { defaults: Record<string, { agent: { value: string; from: string } }> };
    expect(listed.defaults[project.id]!.agent).toEqual({ value: "claude", from: "project" });
    await h.run("projects", "set", project.name, "--reset", "agent");
    const back = h.json((await h.run("projects", "--json")).io).at(-1) as { defaults: Record<string, { agent: { value: string; from: string } }> };
    expect(back.defaults[project.id]!.agent).toEqual({ value: "codex", from: "default" });
  });

  it("a model hidden from an agent's picker leaves the lists the composer draws, and a run still takes it by name", async () => {
    await h.macProject("mac");
    const [mac] = await h.rt.workspaces.list();
    expect((await h.run("agents", "set", "claude", "--hide", "claude-haiku-4-5-20251001")).code).toBe(0);
    const listed = (await h.rt.harnesses.list(mac!.id)).find(c => c.harness === "claude")!;
    expect(listed.models.map(m => m.value)).not.toContain("claude-haiku-4-5-20251001");
    expect((await h.run("run", "mac", "--model", "claude-haiku-4-5-20251001", "go")).code).toBe(0);
    expect(h.claude.starts.at(-1)!.model).toBe("claude-haiku-4-5-20251001");
    await h.run("agents", "set", "claude", "--show", "claude-haiku-4-5-20251001");
    expect((await h.rt.preferences.get()).agentDefaults["claude"]).toEqual({ models: {} });
  });

  it("an agent's setup takes each variable's value where nothing echoes it, and no answer or listing prints it", async () => {
    const io = captured();
    io.isTTY = true;
    const prompts: string[] = [];
    io.askSecret = async q => (prompts.push(q), "bar-s3cret");
    const code = await cli(["agents", "setup", "claude", "--env", "FOO", "--json", "--state", h.statePath], io, undefined, h.env);
    expect(code).toBe(0);
    expect(prompts).toEqual(["FOO for Claude Code"]);
    expect(h.json(io).at(-1)).toMatchObject({ agent: { id: "claude", setup: { on: true, envNames: ["FOO"] } } });
    const listed = await h.run("agents", "--json");
    for (const said of [io.screen, listed.io.screen]) expect(said).not.toContain("bar-s3cret");
    // Nobody at the terminal to type a value: refused before anything is asked or sent.
    const piped = await h.run("agents", "setup", "claude", "--env", "BAR");
    expect(piped.code).toBe(3);
    const named = await h.run("agents", "setup", "claude", "--env", "BAR=baz");
    expect(named.code).toBe(3);
    // A variable that decides how the agent's process starts is refused before its value is asked for.
    const guarded = captured();
    guarded.isTTY = true;
    guarded.askSecret = async q => (prompts.push(q), "/evil");
    expect(await cli(["agents", "setup", "claude", "--env", "LD_PRELOAD", "--state", h.statePath], guarded, undefined, h.env)).toBe(3);
    expect(guarded.errors[0]).toBe("wsp agents setup: LD_PRELOAD decides how Claude Code starts or what it loads, so an agent's setup does not set it. Name another variable; this one is the computer's to say.");
    expect(prompts).toEqual(["FOO for Claude Code"]);
  });

  it("an agent turned off on this computer leaves its lists, and a run naming it is refused naming the computer", async () => {
    await h.macProject("mac");
    expect((await h.run("agents", "setup", "codex", "--disable")).code).toBe(0);
    const [mac] = await h.rt.workspaces.list();
    expect((await h.rt.harnesses.list(mac!.id)).map(c => c.harness)).toEqual(["claude"]);
    const off = await h.run("run", "mac", "--agent", "codex", "go");
    expect(off.code).toBe(3);
    expect(off.io.errors[0]).toMatch(/^wsp run: Codex is off on /);
    expect((await h.run("agents", "setup", "codex", "--enable")).code).toBe(0);
    expect((await h.run("run", "mac", "--agent", "codex", "go")).code).toBe(0);
  });

  it.runIf(CLOUD_ON)("a model, effort or access mode the agent's catalog does not list is refused with that list, in the composer's words, and nothing starts", async () => {
    await h.run("new", "alpha");
    const model = await h.run("run", "alpha", "--model", "claude-haiku-4-5", "review it");
    expect(model.code).toBe(3);
    expect(model.io.errors).toEqual([`wsp run: model "claude-haiku-4-5" is not one claude takes; one of: Opus 5.5 (claude-opus-5-5), Fable 5.1 (claude-fable-5-1), Sonnet 5 (claude-sonnet-5), Haiku 4.5 (claude-haiku-4-5-20251001); legacy: Opus 5 (claude-opus-5), Opus 4.8 (claude-opus-4-8), Opus 4.7 (claude-opus-4-7), Opus 4.6 (claude-opus-4-6), Opus 4.5 (claude-opus-4-5), Fable 5 (claude-fable-5), Sonnet 4.6 (claude-sonnet-4-6), Sonnet 4.5 (claude-sonnet-4-5)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    const effort = await h.run("run", "alpha", "--effort", "ultra", "review it");
    expect(effort.code).toBe(3);
    expect(effort.io.errors).toEqual([`wsp run: effort "ultra" is not one Opus 5.5 takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    withDaemonRoads(h.backend);
    const access = await h.run("fork", "alpha", "--send", "build it", "--access", "yolo");
    expect(access.code).toBe(3);
    expect(access.io.errors[0]).toBe("wsp fork: --access takes ask, auto-edit, full or plan, and got yolo. Name one of those; which of its own modes each one is, is the agent's row's to say.");
    // Checked against the table before the fork is minted, for the named agent or the default one.
    const other = await h.run("fork", "alpha", "--send", "build it", "--agent", "codex", "--effort", "minimal");
    expect(other.code).toBe(3);
    expect(other.io.errors).toEqual([
      `wsp fork: effort "minimal" is not one GPT-5.6-Sol takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max), Ultra (ultra)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`,
    ]);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(h.claude.starts).toEqual([]);
    expect(h.codex.starts).toEqual([]);
    expect(await h.rt.sessions.list()).toEqual([]);
    const dangling = await h.run("fork", "alpha", "--model", "claude-sonnet-5");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --model says how a thread opens, and this line opens none. Add --send "<task>", or drop --model.']);
  });

  it("a refusal off wsp's built-in list says so, and one off the machine's own answer does not", async () => {
    await h.run("new", "alpha");
    const described = { version: "0.153.0", models: [{ slug: "gpt-5.6-sol", label: "GPT-5.6-Sol", contextWindows: [], isDefault: true }], efforts: ["low", "high"], permissionModes: ["read-only"] };
    h.backend.execImpl = (_m, cmd) => (cmd === PROBE_CMD ? { exitCode: 0, stdout: JSON.stringify(described), stderr: "" } : guestAnswer(cmd));
    const [alpha] = await h.rt.workspaces.list();
    // The claude here describes nothing, so the list its refusal quotes is wsp's own table; the codex describes
    // itself, so its refusal quotes the machine's own answer.
    const listed = await h.rt.harnesses.list(alpha!.id);
    expect(listed.find(c => c.harness === "claude")!.source).toBe("table");
    expect(listed.find(c => c.harness === "codex")!.source).toBe("harness");
    const table = await h.run("run", "alpha", "--model", "claude-opus-4-1", "review it");
    expect(table.code).toBe(3);
    expect(table.io.errors[0]).toContain("that list is wsp's built-in one");
    expect(table.io.errors[0]).toContain("the agent on that computer may take more");
    expect(table.io.errors).toHaveLength(1);

    const own = await h.run("run", "alpha", "--agent", "codex", "--model", "gpt-4", "review it");
    expect(own.code).toBe(3);
    // The machine's own agent named its models, so there is nothing to warn the person about.
    expect(own.io.errors).toEqual(['wsp run: model "gpt-4" is not one codex takes; one of: GPT-5.6-Sol (gpt-5.6-sol). Drop the flag, or give it a value the agent offers.']);
    expect(h.claude.starts).toEqual([]);
    expect(h.codex.starts).toEqual([]);
  });

  it("a run on this computer checks a model against the agent's own list there, the one its start and the composer read, before a worktree is made", async () => {
    const described: HarnessCatalogAnswer = {
      version: "2.1.0",
      models: [
        { slug: "claude-sonnet-5-5", label: "Sonnet 5.5", contextWindows: [], isDefault: true },
        { slug: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [], isDefault: false },
      ],
      efforts: ["low", "high"],
      permissionModes: ["default", "acceptEdits", "bypassPermissions"],
    };
    await h.restartHost({ claude: ctx => ({ ...h.claude.adapter(ctx), probeCatalog: async () => described }), codex: probing(h.codex.adapter) });
    const { folder } = await h.macProject("mac");
    execFileSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    const [mac] = await h.rt.workspaces.list();
    expect((await h.rt.harnesses.list(mac!.id)).find(c => c.harness === "claude")!.models.map(m => m.value)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5"]);

    const only = await h.run("run", "mac", "--model", "claude-sonnet-5-5", "go");
    expect(only.code, only.io.errors.join("\n")).toBe(0);
    expect(h.claude.starts.at(-1)!.model).toBe("claude-sonnet-5-5");

    const listed = 'wsp run: model "claude-opus-4-1" is not one claude takes; one of: Sonnet 5.5 (claude-sonnet-5-5), Sonnet 5 (claude-sonnet-5)';
    const gone = await h.run("run", "mac", "--model", "claude-opus-4-1", "go");
    expect(gone.code).toBe(3);
    expect(gone.io.errors).toHaveLength(1);
    expect(gone.io.errors[0]!.startsWith(listed)).toBe(true);
    expect(gone.io.errors[0]).not.toContain("built-in");
    const branched = await h.run("run", "mac", "--branch", "feat/x", "--model", "claude-opus-4-1", "go");
    expect(branched.code).toBe(3);
    expect(branched.io.errors[0]!.startsWith(listed)).toBe(true);
    expect(h.copier.worktrees).toEqual([]);
    expect(h.claude.starts).toHaveLength(1);
  });

  it("a refusal off wsp's built-in list that quotes no list says whose word it is, as one sentence", async () => {
    await h.run("new", "alpha");
    const none = await h.run("run", "alpha", "--model", "claude-haiku-4-5-20251001", "--effort", "high", "review it");
    expect(none.code).toBe(3);
    expect(none.io.errors).toEqual([`wsp run: Haiku 4.5 takes no effort${BUILT_IN_TABLE_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    expect(BUILT_IN_TABLE_CLAUSE).toBe("; wsp's built-in table says so, since no agent there described itself");
    expect(h.claude.starts).toEqual([]);
  });

  it("runs a legacy model at an effort the binary lists for it", async () => {
    await h.run("new", "alpha");
    const older = await h.run("run", "alpha", "--model", "claude-opus-5", "--effort", "high", "review it");
    expect(older.code).toBe(0);
    expect(h.claude.starts.map(s => [s.model, s.effort])).toEqual([["claude-opus-5", "high"]]);
  });

  it.runIf(CLOUD_ON)("checks a pick against the workspace's own machine, so a model only that machine knows is taken here as the app takes it", async () => {
    await h.run("new", "alpha");
    // A machine routed to another model provider: its codex names a model no table carries, and the app's composer
    // takes it because sessions.start checks the probed catalog. The command line has to agree with the app.
    const routed = {
      version: "0.153.0",
      models: [{ slug: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", contextWindows: [], isDefault: true }],
      efforts: ["low", "high"],
      permissionModes: ["read-only"],
    };
    h.backend.execImpl = (_m, cmd) => (cmd === PROBE_CMD ? { exitCode: 0, stdout: JSON.stringify(routed), stderr: "" } : guestAnswer(cmd));
    const opened = await h.run("run", "alpha", "--agent", "codex", "--model", "anthropic/claude-sonnet-4.5", "--effort", "high", "go");
    expect(opened.code).toBe(0);
    expect(h.codex.starts.at(-1)).toMatchObject({ model: "anthropic/claude-sonnet-4.5", effort: "high" });
    // The same list refuses a table model that machine does not have, naming the machine's own, and a fork checks
    // the workspace it forks from, whose golden the new machine comes from.
    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--send", "go", "--agent", "codex", "--model", "gpt-5.5");
    expect(forked.code).toBe(3);
    expect(forked.io.errors).toEqual(['wsp fork: model "gpt-5.5" is not one codex takes; one of: anthropic/claude-sonnet-4.5 (anthropic/claude-sonnet-4.5). Drop the flag, or give it a value the agent offers.']);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
  });

  it.runIf(CLOUD_ON)("a --cwd that is not absolute is refused with the usage line before anything is created, started or dialled; fork's --cwd needs --send", async () => {
    await h.run("new", "alpha");
    const relative = await h.run("run", "alpha", "--cwd", "packages/host", "look here");
    expect(relative.code).toBe(3);
    // The usage the refusal carries is the verb's own, whatever its groups are; the words before it are the rule.
    expect(relative.io.errors).toEqual([`--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: ${CLI_VERBS.find(v => v.name === "run")!.usage}`]);
    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--send", "build it", "--cwd", "packages/host");
    expect(forked.code).toBe(3);
    expect(forked.io.errors[0]).toMatch(/^--cwd is a path on the machine, absolute, and got "packages\/host"\..* usage: wsp fork /);
    const dangling = await h.run("fork", "alpha", "--cwd", "/root/work");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --cwd says how a thread opens, and this line opens none. Add --send "<task>", or drop --cwd.']);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await h.rt.sessions.list()).toEqual([]);
    expect(h.claude.starts).toEqual([]);
  });

  it("projects shortens a path that would not fit its column with an ellipsis at the front, keeping the end a person recognises", async () => {
    const deep = await projectOn(h.rt, undefined, "https://github.com/dev/a-project-with-a-very-long-name-indeed-and-then-some-more.git", { name: "a-project-with-a-very-long-name-indeed-and-then-some-more-again" });
    const { io } = await h.run("projects");
    const line = io.lines[0]!.split("\n").find(r => r.startsWith(deep.name))!;
    expect(line).toContain("…");
    expect(line).toContain(deep.path.slice(-20));
    expect(line).not.toContain(deep);
    // The path is cut for the column and whole on the wire.
    const asJson = await h.run("projects", "--json");
    const [{ projects }] = h.json(asJson.io) as [{ projects: { name: string; path: string }[] }];
    expect(projects.find(p => p.name === deep.name)!.path).toBe(deep.path);
  });

  it("threads shows a multi-paragraph brief as one row, titled by the protocol's rule: its first sentence cut at a word to 48 characters, the same title the sidebar shows", async () => {
    await h.run("new", "alpha");
    const brief = "You are a builder for the wsp repo, which is at /Users/zingzy/wsp on this machine.\n\nTicket: wsp-labs/wsp-map#292.\nBuild: the fix.";
    await h.run("run", "alpha", brief);
    const { io } = await h.run("threads");
    const rows = io.lines[0]!.split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/  You are a builder for the wsp repo, which is at…\s*$/);
    const asJson = await h.run("threads", "--json");
    const [{ threads }] = h.json(asJson.io) as [{ threads: ThreadView[] }];
    expect(threads[0]!.title).toBe("You are a builder for the wsp repo, which is at…");
  });
});
