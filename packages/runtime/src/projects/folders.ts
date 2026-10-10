// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { ECOSYSTEM_MODULES } from "@wsp/catalog";
import { CHILD_TIMED_OUT, INLINE_EXEC_MS, LOCAL_MACHINE_ID } from "@wsp/engine";
import type { ProjectView, Caller } from "@wsp/protocol";
import { threadWord, scopeOf } from "@wsp/protocol";
import { hereDaemonBehindLine, homeShortened, DAEMON_VERSION, folderName, NAME_A_PROJECT_LINE, BRANCH_OR_CWD_LINE, notOnThisComputerLine, cwdOutsideLine, noBranchesLine, notMadeWorktreeLine, OLD_COPY_WORDS, ProjectCopy, WORKTREE_BUSY_LINE, worktreeChangedLine, keptChangedLine, KEPT_RUNNING_LINE, KEPT_ABANDONED_LINE, type WorktreeFolder, type WorktreeSettled, copiesFolder, guestNamesWorkspaceLine, GUEST_NAMES_FIX, placeBranchLine, refusalLine, runsInFolder, shellLine, workspaceLands, worktreeCommandFailedLine, worktreeCommandRunningLine, worktreeStepWords, worktreeSetupLine, type CarryModule, type WorktreeReport } from "@wsp/protocol";
import { takenNameAfter } from "@wsp/protocol";
import type { StartPicksAsked } from "../types/harness.js";
import { type WorkspaceRecord, type LiveWorkspace, CLONE_MS, folderNamed, NO_COPIER_HERE, lastLineOf } from "../types/wiring.js";
import type { RuntimeContext, FoldersArea } from "../context.js";

/** The ecosystems as the worktree verb is handed them, their rebuilds kept here, where they run. */
const CARRY_MODULES: CarryModule[] = ECOSYSTEM_MODULES.map(({ id, lockfiles, carry, never, installed }) => ({ id, lockfiles, carry, never, ...(installed !== undefined ? { installed } : {}) }));

/** How long one command a new worktree runs may take: an install stalled on the network, or a line that waits on an
 * answer nobody gives, holds the start of a thread no longer than this. */
const WORKTREE_COMMAND_MS = 3 * 60_000;

export function foldersArea(ctx: RuntimeContext): FoldersArea {
  const { local, bus, clock, live, projectsHeld, threadRecords, sessions } = ctx;
  /** A folder's record, written once: the machine is the computer holding the project, this one or one the person
   * joined, running, with auto-nap off, since a machine wsp does not run neither naps nor wakes. Its name is the
   * project's, or the project's with the branch for a worktree, and nothing shows it to a person. */
  const recordFolder = async (project: ProjectView, worktree?: WorktreeFolder, parent?: string): Promise<LiveWorkspace> => {
    const kind = ctx.kindOf(project.computer);
    const lands = workspaceLands(project.computer, undefined);
    const place = lands.at === "place" ? lands.place : undefined;
    await ctx.moduleOf(kind).admitFolder?.({ kind, name: project.name, ...(place !== undefined ? { place } : {}) });
    const mine = ctx.backendOfKind(kind, place);
    const machine = await mine.get(place ?? LOCAL_MACHINE_ID);
    const id = `ws_${randomBytes(4).toString("hex")}`;
    const taken = new Set([...live.values()].map(e => e.record.name));
    const record: WorkspaceRecord = {
      id,
      name: takenNameAfter(worktree?.branch === undefined ? project.name : `${project.name}@${worktree.branch}`, taken),
      kind,
      ...(place !== undefined ? { place } : {}),
      machineId: machine.id,
      phase: "running",
      golden: "",
      createdAt: new Date(clock.now()).toISOString(),
      project: project.id,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(parent !== undefined ? { parentWorkspaceId: parent } : {}),
      spec: {},
      size: mine.pricing.defaultSize,
      firstLife: false,
      idleWindowMs: null,
    };
    ctx.attach(record, machine);
    await ctx.persist(record);
    // A project folder outside the person's home, or a worktree under the host's own folder, is outside the daemon's
    // home root, and the host's start lists only the records it found, so the file is written before a turn's snapshot.
    await ctx.writeDaemonRoots(live.get(id)!);
    if (worktree?.made === true) armSweep();
    bus.emit({ type: "workspace.created", workspace: ctx.view(record) });
    return live.get(id)!;
  };
  /** The project folder's record, made at its first thread. */
  const projectFolder = (project: ProjectView): Promise<LiveWorkspace> => {
    const held = ctx.foldersOf(project.id).find(e => e.record.worktree === undefined);
    if (held !== undefined) return Promise.resolve(held);
    return ctx.oneFolder(`${project.id}\0`, () => recordFolder(project));
  };
  /** The record of the worktree holding a branch of the project's repo: the one git already has the branch checked
   * out in, wherever it is, or one the daemon binary makes under this host's folder. The project folder itself
   * answers when it is the one holding the branch. */
  const worktreeFolder = (project: ProjectView, top: string, branch: string, parent?: string, madeFor?: string): Promise<LiveWorkspace> =>
    ctx.oneFolder(`${project.id}\0${branch}`, async () => {
      const copier = local?.copier;
      if (copier === undefined) throw Object.assign(new Error(NO_COPIER_HERE), { kind: "invalid" });
      // Before the binary is run at all: one older than this wsp answers a verb it never heard of with its usage text.
      const here = local?.hereDaemon;
      if (here !== undefined) {
        const version = await here.version();
        if (version < DAEMON_VERSION) throw new Error(hereDaemonBehindLine(version, DAEMON_VERSION, here.fix));
      }
      const made = await copier.worktree({ from: top, home: ctx.stateFolder(), project: project.id, branch, modules: CARRY_MODULES });
      if (made.path === top) return projectFolder(project);
      const entry = await worktreeRecordAt(project, { path: made.path, branch: made.branch, made: made.made, ...(madeFor !== undefined ? { madeFor } : {}) }, parent);
      if (made.fresh) {
        const said = await settleWorktree(project, made);
        if (said !== undefined) setupLines.set(entry.record.id, said);
      }
      return entry;
    });
  /** What a new worktree ran, kept for the first turn that starts there to open with. */
  const setupLines = new Map<string, string>();
  const takeSetupLine = (workspaceId: string): string | undefined => {
    const said = setupLines.get(workspaceId);
    setupLines.delete(workspaceId);
    return said;
  };
  /** What a worktree this call made runs once before any thread starts there, in order: the install of each module
   * the verb found in a folder of it and not already installed for its lockfile, in that folder, then the project's
   * own after-worktree command at its top. Each is said as it starts, runs with nothing on its stdin and no longer
   * than WORKTREE_COMMAND_MS, and one that fails is said; the thread starts all the same, since the agent can run it
   * again and read why. Answers the line the first thread there opens with. */
  const settleWorktree = async (project: ProjectView, made: WorktreeReport): Promise<string | undefined> => {
    const own = (await ctx.preferences.get()).projectDefaults[project.id]?.afterWorktree;
    const installs = made.modules.filter(m => m.rebuild).flatMap(m => ECOSYSTEM_MODULES.filter(e => e.id === m.id).map(e => ({ command: e.rebuild, folder: m.folder })));
    const commands = [...installs, ...(own !== undefined ? [{ command: own, folder: "." }] : [])];
    if (commands.length === 0) return undefined;
    const machine = await ctx.backendOfKind("local").get(LOCAL_MACHINE_ID);
    const steps: string[] = [];
    for (const { command, folder } of commands) {
      const at = folder === "." ? made.path : join(made.path, folder);
      const shown = homeShortened(at, homedir());
      bus.emit({ type: "host.notice", message: worktreeCommandRunningLine(command, shown) });
      const ran = await machine.exec(`cd ${shellLine([at])} && ${command}`, { timeoutMs: WORKTREE_COMMAND_MS, stdin: new Uint8Array() });
      if (ran.exitCode === 0) {
        steps.push(worktreeStepWords(command, folder));
        continue;
      }
      const end = ran.exitCode === CHILD_TIMED_OUT ? { stoppedAfterMin: WORKTREE_COMMAND_MS / 60_000 } : { exitCode: ran.exitCode, said: lastLineOf(ran.stderr.trim() || ran.stdout.trim()) };
      console.warn(`${command} in ${at} exited ${ran.exitCode}: ${ran.stderr.trim() || ran.stdout.trim()}`);
      bus.emit({ type: "host.notice", message: worktreeCommandFailedLine(command, shown, end) });
      steps.push(worktreeStepWords(command, folder, end));
    }
    return worktreeSetupLine(steps);
  };
  /** The dependency overlays of a worktree wsp made mounted again before a turn or a command runs there, where a
   * restart of this computer took them; anything else asks nothing. One that cannot be mounted is said in the log and
   * the turn runs all the same. */
  const worktreeMounted = async (entry: LiveWorkspace): Promise<void> => {
    const tree = entry.record.worktree;
    const top = ctx.projectHeld(entry.record.project).git?.top;
    const copier = local?.copier;
    if (tree?.made !== true || tree.gone === true || top === undefined || copier === undefined || !existsSync(tree.path)) return;
    await copier.worktreeMount({ from: top, home: ctx.stateFolder(), path: tree.path }).catch((e: unknown) => console.warn(`the worktree at ${tree.path} was not mounted again: ${e instanceof Error ? e.message : String(e)}`));
  };
  /** The record naming a worktree at this path, written again where one stands from before (a worktree removed and
   * made again comes back to its threads, and to the tree it was made for), else a new one, a child of the folder
   * whose thread asked for it so its branch merges back there. */
  const worktreeRecordAt = async (project: ProjectView, tree: WorktreeFolder, parent?: string): Promise<LiveWorkspace> => {
    const held = ctx.foldersOf(project.id).find(e => e.record.worktree?.path === tree.path);
    if (held === undefined) return recordFolder(project, tree, parent);
    const was = held.record.worktree!;
    const madeFor = was.madeFor;
    held.record.worktree = { path: tree.path, made: was.made || tree.made, ...(tree.branch !== undefined ? { branch: tree.branch } : {}), ...(madeFor !== undefined ? { madeFor } : {}) };
    await ctx.persist(held.record);
    armSweep();
    return held;
  };
  /** Where a thread asked for on this computer runs: the record of its folder and the folder itself where the start
   * named one. Nothing named runs in the project folder, or beside the thread asking; a branch runs in the worktree
   * holding it, the project folder when it is that folder's own branch; a cwd runs where it is, inside the project
   * folder or a worktree of its repo and nowhere else. */
  const folderFor = async (o: { project?: string; branch?: string; cwd?: string; picks?: StartPicksAsked }, origin: Caller | undefined): Promise<{ entry: LiveWorkspace; cwd?: string }> => {
    const scope = scopeOf(origin);
    const asking = scope === undefined ? undefined : live.get(scope.workspaceId);
    // A thread on a machine wsp forked has no folder to run beside: it names the workspace it means.
    if (o.project === undefined && asking !== undefined && !runsInFolder(asking.record.kind)) throw Object.assign(new Error(refusalLine(guestNamesWorkspaceLine, GUEST_NAMES_FIX)), { kind: "usage" });
    // A thread on a computer the person joined starts threads on that computer alone, said before the project rule
    // reads the word as absent. A word its own project answers is its own, whatever another computer's is called.
    const own = asking === undefined || asking.record.place === undefined ? undefined : ctx.projectHeld(asking.record.project);
    const from = own?.computer;
    const elsewhere = own === undefined || o.project === undefined || o.project === own.id || o.project === own.name ? undefined : [...projectsHeld.values()].find(p => (p.id === o.project || p.name === o.project) && p.computer !== from);
    const away = elsewhere === undefined || o.project === undefined ? undefined : ctx.elsewhereRefusal(origin, elsewhere, o.project);
    if (away !== undefined) throw away;
    const project = o.project !== undefined ? await ctx.projectsDoor.resolve(o.project, origin) : asking !== undefined ? ctx.projectHeld(asking.record.project) : undefined;
    if (project === undefined) throw Object.assign(new Error(NAME_A_PROJECT_LINE), { kind: "usage" });
    const kind = ctx.kindOf(project.computer);
    if (!runsInFolder(kind)) throw Object.assign(new Error(notOnThisComputerLine(project.name)), { kind: "usage" });
    if (o.picks !== undefined) await ctx.picksHold(project, o.picks);
    const beside = asking !== undefined && runsInFolder(asking.record.kind) && asking.record.project === project.id ? asking : undefined;
    if (o.branch !== undefined && o.cwd !== undefined) throw Object.assign(new Error(BRANCH_OR_CWD_LINE), { kind: "usage" });
    // A folder on a computer the person joined runs in the project folder or a folder inside it: its worktrees are
    // read and made by this computer's own git and copier, which reach no other.
    if (!copiesFolder(kind)) {
      if (o.branch !== undefined) throw Object.assign(new Error(placeBranchLine(ctx.placeName(project.computer))), { kind: "usage" });
      const cwd = o.cwd === undefined ? undefined : posix.normalize(o.cwd);
      if (cwd !== undefined && (!posix.isAbsolute(cwd) || !under(cwd, project.path))) throw Object.assign(new Error(cwdOutsideLine(cwd, project.name)), { kind: "usage" });
      return { entry: beside !== undefined && beside.record.worktree === undefined ? beside : await projectFolder(project), ...(cwd !== undefined ? { cwd } : {}) };
    }
    const top = project.git?.top;
    if (o.cwd !== undefined) {
      const cwd = folderNamed(o.cwd);
      if (under(cwd, project.path)) return { entry: beside !== undefined && beside.record.worktree === undefined ? beside : await projectFolder(project), cwd };
      const held = top === undefined ? undefined : (await worktreesOf(top)).find(w => under(cwd, w.path));
      if (held === undefined || top === undefined) throw Object.assign(new Error(cwdOutsideLine(homeShortened(cwd, homedir()), project.name)), { kind: "usage" });
      if (held.path === top) return { entry: await projectFolder(project), cwd };
      // A worktree wsp holds no record of, one made with plain git worktree add, is the asking thread's tree's from here.
      return { entry: await worktreeRecordAt(project, { path: held.path, ...(held.branch !== undefined ? { branch: held.branch } : {}), made: false, ...(scope !== undefined ? { madeFor: scope.rootThreadId } : {}) }), cwd };
    }
    if (o.branch === undefined) return { entry: beside ?? (await projectFolder(project)) };
    if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
    if ((await ctx.branchAt(beside !== undefined ? ctx.checkoutOf(beside.record) : project.path)) === o.branch) return { entry: beside ?? (await projectFolder(project)) };
    return { entry: await worktreeFolder(project, top, o.branch, beside?.record.id, scope?.rootThreadId) };
  };
  /** The host's own git writes on one folder, one at a time: two threads' commits, a discard and a removal never
   * interleave. The agents' own git is theirs, and git's index lock is the answer when theirs meets this. */
  const gitWrites = new Map<string, Promise<unknown>>();
  const queued = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const run = (gitWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = run.catch(() => {});
    gitWrites.set(id, tail);
    void tail.then(() => {
      if (gitWrites.get(id) === tail) gitWrites.delete(id);
    });
    return run;
  };
  /** Takes a worktree wsp made away with git, under the folder's queue: never while a turn runs there and never over
   * files no commit holds unless forced; the verb keeps a detached HEAD under refs/rescue first. The record stays,
   * gone, while threads name it, and goes with the last of them. */
  const removeWorktree = (entry: LiveWorkspace, force: boolean, o: { ending?: boolean; check?: boolean } = {}): Promise<void> =>
    queued(entry.record.id, async () => {
      const tree = entry.record.worktree;
      const project = ctx.projectHeld(entry.record.project);
      const top = project.git?.top;
      if (tree === undefined || tree.made !== true || top === undefined) throw new Error(notMadeWorktreeLine(tree?.branch ?? ""));
      const copier = local?.copier;
      if (copier === undefined) throw Object.assign(new Error(NO_COPIER_HERE), { kind: "invalid" });
      if (o.ending !== true && ctx.turnRuns(entry.record.id)) throw Object.assign(new Error(WORKTREE_BUSY_LINE), { kind: "conflict" });
      if (existsSync(tree.path) && !force) await refuseChanged(tree.path);
      if (o.check === true) return;
      if (existsSync(tree.path)) {
        await copier.worktreeRemove({ from: top, home: ctx.stateFolder(), path: tree.path, force });
      }
      if (o.ending !== true) await worktreeGone(entry, "removed");
    });
  /** Refuses over files no commit holds in a folder, naming how many: they would go with a removal. */
  const refuseChanged = async (path: string): Promise<void> => {
    const read = await ctx.gitHere(path, ["status", "--porcelain"]);
    if (read.exitCode !== 0) throw new Error(read.stderr.trim() || read.stdout.trim());
    const changed = read.stdout.split("\n").filter(l => l.trim() !== "").length;
    if (changed > 0) throw Object.assign(new Error(worktreeChangedLine(changed)), { kind: "conflict" });
  };
  /** Drops the checkpoint refs one thread holds in its folder's repo, best effort: a ref left behind pins files and
   * nothing else, and a delete is not refused for it. */
  const dropCheckpoints = async (entry: LiveWorkspace, threadId: string): Promise<void> => {
    await ctx.checkpointsLanding.get(threadId)?.catch(() => {});
    if (ctx.notARepo(entry.record)) return;
    await ctx.withDaemon(entry, ask => ask({ op: "git.checkpointDrop", cwd: ctx.checkoutOf(entry.record), scope: entry.record.id, thread: threadId })).catch((e: unknown) =>
      console.warn(`the checkpoints of thread ${threadWord(threadId)} were not dropped: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  /** Whether any thread names a record, by a row of its turns or by its own record. */
  const holdsThread = (workspaceId: string): boolean =>
    [...sessions.values()].some(s => s.view.workspaceId === workspaceId) || [...threadRecords.values()].some(t => t.workspaceId === workspaceId);
  /** A worktree no longer on disk: its threads go on in the project folder, and its record goes once no thread is
   * left on it. */
  const worktreeGone = async (entry: LiveWorkspace, why: WorktreeSettled["why"], o: { starting?: boolean } = {}): Promise<void> => {
    const tree = entry.record.worktree;
    if (tree === undefined) return;
    // A start found it gone, and its thread is about to name the record.
    if (o.starting !== true && !holdsThread(entry.record.id)) {
      await ctx.drop(entry.record.id);
      return;
    }
    entry.record.worktree = { path: tree.path, made: tree.made, ...(tree.branch !== undefined ? { branch: tree.branch } : {}), ...(tree.madeFor !== undefined ? { madeFor: tree.madeFor } : {}), settled: tree.settled ?? { at: clock.now(), why }, gone: true };
    await ctx.persist(entry.record);
  };
  /** The folder a thread's next turn runs in: where its session last ran, unless that was a worktree that is gone,
   * whose threads go on in the folder the record answers now. */
  const runsIn = (entry: LiveWorkspace, ranIn: string | undefined, folder: string): string => {
    const tree = entry.record.worktree;
    if (ranIn === undefined) return folder;
    return tree?.gone === true && under(ranIn, tree.path) ? folder : ranIn;
  };
  /** The one sweep of the worktrees wsp made: how often it runs, how long a settled one stands before it goes, and how
   * long one that could not go is tried before it is the person's to remove. */
  const SWEEP_MS = 10 * 60_000;
  const SETTLED_STANDS_MS = 6 * 3_600_000;
  const KEPT_FOR_MS = 7 * 24 * 3_600_000;
  /** Whether any worktree wsp made still stands, which is all the sweep has to look at. */
  const sweepHasWork = (): boolean => [...live.values()].some(e => e.record.worktree?.made === true && e.record.worktree.gone !== true);
  /** Armed only while a worktree wsp made stands: a host with none holds no timer for it. */
  const armSweep = (): void => {
    if (ctx.state.sweepTimer !== undefined || ctx.state.sweeping !== undefined) return;
    if (ctx.state.sweepStopped || !sweepHasWork()) return;
    ctx.state.sweepTimer = clock.schedule(
      () => {
        ctx.state.sweepTimer = undefined;
        ctx.state.sweeping = sweepWorktrees()
          .catch((e: unknown) => console.warn(`the sweep of worktrees stopped: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            ctx.state.sweeping = undefined;
            armSweep();
          });
      },
      SWEEP_MS,
      { unref: true },
    );
  };
  /** Every worktree wsp made and still holds, one at a time, so a sweep is never more git than one folder's at once. */
  const sweepWorktrees = async (): Promise<void> => {
    for (const entry of [...live.values()]) {
      const tree = entry.record.worktree;
      if (tree?.made !== true || tree.gone === true || live.get(entry.record.id) !== entry) continue;
      await sweepOne(entry).catch((e: unknown) => console.warn(`the worktree at ${tree.path} was not swept: ${e instanceof Error ? e.message : String(e)}`));
    }
  };
  /** One worktree wsp made: settled when its pull request merged or closed, when the branch it pushed is gone at the
   * remote, or when the person removed it; once settled six hours with nothing uncommitted and no turn running it
   * goes, and otherwise says why it stays, until a week has passed and it is left to the person. */
  const sweepOne = async (entry: LiveWorkspace): Promise<void> => {
    const tree = entry.record.worktree!;
    if (!existsSync(tree.path)) return worktreeGone(entry, "removed");
    const settled = tree.settled ?? (await settledNow(entry));
    if (settled === undefined || tree.kept === KEPT_ABANDONED_LINE) return;
    const age = clock.now() - settled.at;
    if (age < SETTLED_STANDS_MS) return;
    const keep = async (said: { kept?: string; removeFailed?: string }): Promise<void> => {
      const now = entry.record.worktree!;
      const next: WorktreeFolder = { ...now, ...said, ...(age >= KEPT_FOR_MS ? { kept: KEPT_ABANDONED_LINE } : {}) };
      if (JSON.stringify(next) === JSON.stringify(now)) return;
      entry.record.worktree = next;
      await ctx.persist(entry.record);
      await ctx.statusNow(entry);
    };
    if (ctx.turnRuns(entry.record.id)) return keep({ kept: KEPT_RUNNING_LINE });
    const status = await ctx.gitHere(tree.path, ["status", "--porcelain"]);
    const changed = status.stdout.split("\n").filter(l => l.trim() !== "").length;
    if (status.exitCode === 0 && changed > 0) return keep({ kept: keptChangedLine(changed) });
    try {
      await removeWorktree(entry, false);
    } catch (e) {
      await keep({ removeFailed: lastLineOf(e instanceof Error ? e.message : String(e)) });
    }
  };
  /** Whether a worktree wsp made settled since the last sweep, stamped on its record when it did. Only a branch with an
   * upstream is asked of its remote, and only the remote saying it has no such branch counts; no remote, no upstream
   * or a remote that could not be read is no answer, so a branch never pushed keeps its worktree. */
  const settledNow = async (entry: LiveWorkspace): Promise<WorktreeSettled | undefined> => {
    const tree = entry.record.worktree!;
    if (ctx.projectHeld(entry.record.project).remote === "") return undefined;
    await ctx.readPullRequest(entry, true);
    const pr = entry.record.pr;
    let settled: WorktreeSettled | undefined =
      pr?.state === "merged" ? { at: pr.mergedAt ?? clock.now(), why: "merged" } : pr?.state === "closed" ? { at: pr.closedAt ?? clock.now(), why: "closed" } : undefined;
    if (settled === undefined && tree.branch !== undefined && (await branchGoneAtRemote(tree.path, tree.branch))) settled = { at: clock.now(), why: "deleted" };
    if (settled === undefined) return undefined;
    entry.record.worktree = { ...entry.record.worktree!, settled };
    await ctx.persist(entry.record);
    await ctx.statusNow(entry);
    return settled;
  };
  /** True only where the branch has an upstream and its remote answers that it holds no such branch (exit 2). */
  const branchGoneAtRemote = async (path: string, branch: string): Promise<boolean> => {
    const remote = (await ctx.gitHere(path, ["config", "--get", `branch.${branch}.remote`])).stdout.trim();
    const merge = (await ctx.gitHere(path, ["config", "--get", `branch.${branch}.merge`])).stdout.trim();
    if (remote === "" || merge === "" || remote === ".") return false;
    const machine = await ctx.moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    const asked = await machine.exec(`GIT_TERMINAL_PROMPT=0 ${shellLine(["git", "-C", path, "ls-remote", "--exit-code", "--heads", remote, merge])}`, { timeoutMs: INLINE_EXEC_MS });
    return asked.exitCode === 2;
  };
  /** What the move off copies leaves beside the state: each copy kept, with why. */
  const COPIES_KEPT_FILE = "copies-kept.txt";
  /** The move off copies, once, for every record a build before folder records wrote with a copy of the project.
   * Each copy is kept unless every commit it holds is safe in the project's repo: one with changes no commit holds
   * stays, a copy whose branches could not be fetched into the project stays, and only then is it removed by the
   * road that made it. The record goes either way; what stayed is listed in a file beside the state and said once. */
  const moveOldCopies = async (): Promise<void> => {
    const old = [...live.values()].filter(e => copiesFolder(e.record.kind) && (e.record as { copy?: unknown }).copy !== undefined);
    if (old.length === 0) return;
    const kept: string[] = [];
    for (const entry of old) {
      const copy = ProjectCopy.safeParse((entry.record as { copy?: unknown }).copy);
      ctx.endSessions(entry.record.id, OLD_COPY_WORDS.ended);
      const why = copy.success ? await moveOldCopy(entry, copy.data).catch((e: unknown) => OLD_COPY_WORDS.notRemoved(e instanceof Error ? e.message : String(e))) : undefined;
      if (why !== undefined && copy.success) {
        kept.push(`${copy.data.path}\t${why}`);
        console.warn(`old copy ${copy.data.path} kept: ${why}`);
      }
      await ctx.drop(entry.record.id);
    }
    if (kept.length === 0) return;
    const file = join(ctx.stateFolder(), COPIES_KEPT_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${kept.join("\n")}\n`);
    bus.emit({ type: "host.notice", message: OLD_COPY_WORDS.kept(kept.length, homeShortened(file, homedir())) });
  };
  /** One old copy: why it stays, or nothing once its commits are in the project's repo and it is gone. */
  const moveOldCopy = async (entry: LiveWorkspace, copy: ProjectCopy): Promise<string | undefined> => {
    if (!existsSync(copy.path)) return undefined;
    const project = projectsHeld.get(entry.record.project);
    if (project === undefined) return OLD_COPY_WORDS.noProject;
    const top = project.git?.top ?? project.path;
    const overlaps = (a: string, b: string): boolean => under(a, b) || under(b, a);
    if (overlaps(copy.path, project.path) || overlaps(copy.path, top) || overlaps(copy.path, copy.source)) return OLD_COPY_WORDS.isProject;
    const status = await ctx.gitHere(copy.path, ["status", "--porcelain"]);
    if (status.exitCode !== 0) return OLD_COPY_WORDS.unread(gitSaid(status));
    if (status.stdout.trim() !== "") return OLD_COPY_WORDS.changed;
    const name = refPart(folderName(copy.path));
    if (copy.road === "clonefile") {
      // A stash lives in the copy's own repo and rides no fetch of its branches; a worktree's is the project's own.
      const stash = await ctx.gitHere(copy.path, ["rev-parse", "--verify", "--quiet", "refs/stash"]);
      if (stash.exitCode === 0 && stash.stdout.trim() !== "") return OLD_COPY_WORDS.stashed;
      const failed = await rescueTips(top, copy.path, name);
      if (failed !== undefined) return OLD_COPY_WORDS.fetchFailed(failed);
    } else {
      const head = await ctx.gitHere(copy.path, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      if (head.stdout.trim() !== "") {
        const put = await ctx.gitHere(top, ["update-ref", `refs/rescue/${name}/HEAD`, head.stdout.trim()]);
        if (put.exitCode !== 0) return OLD_COPY_WORDS.fetchFailed(gitSaid(put));
      }
    }
    const copier = local?.copier;
    if (copier === undefined) return OLD_COPY_WORDS.noCopier;
    await copier.remove(copy.source, copy.path, copy.road);
    return undefined;
  };
  /** A clean copy's commits kept in the project's repo: its branches and its HEAD fetched beside the project's refs,
   * then only the tips no branch, remote, tag or earlier rescue of the project reaches kept under refs/rescue, one
   * ref per tip, a branch before HEAD; every fetched ref goes after. A copy shares nearly every branch with its
   * project, and a ref kept for each one slows every git command in that repo. What git said where it failed. */
  const rescueTips = async (top: string, from: string, name: string): Promise<string | undefined> => {
    const incoming = `refs/rescue-incoming/${name}`;
    try {
      // HEAD rides the same fetch, so a commit on no branch is carried too.
      const fetched = await ctx.gitHere(top, ["fetch", "--quiet", "--no-tags", from, `+refs/heads/*:${incoming}/heads/*`, `+HEAD:${incoming}/HEAD`], CLONE_MS);
      if (fetched.exitCode !== 0) return gitSaid(fetched);
      const unreached = await ctx.gitHere(top, ["rev-list", `--glob=${incoming}`, "--not", "--branches", "--remotes", "--tags", "--glob=refs/rescue"], CLONE_MS);
      if (unreached.exitCode !== 0) return gitSaid(unreached);
      const lacking = new Set(unreached.stdout.split("\n").filter(Boolean));
      if (lacking.size === 0) return undefined;
      const listed = await ctx.gitHere(top, ["for-each-ref", "--format=%(objectname) %(refname)", incoming]);
      if (listed.exitCode !== 0) return gitSaid(listed);
      const refs = listed.stdout.split("\n").filter(Boolean).map(line => ({ tip: line.slice(0, line.indexOf(" ")), ref: line.slice(line.indexOf(" ") + 1) }));
      const ordered = [...refs.filter(r => r.ref !== `${incoming}/HEAD`), ...refs.filter(r => r.ref === `${incoming}/HEAD`)];
      const kept = new Set<string>();
      const lines: string[] = [];
      for (const { tip, ref } of ordered) {
        if (!lacking.has(tip) || kept.has(tip)) continue;
        kept.add(tip);
        const rest = ref === `${incoming}/HEAD` ? "HEAD" : ref.slice(`${incoming}/heads/`.length);
        lines.push(`update refs/rescue/${name}/${rest} ${tip}`);
      }
      const put = await ctx.gitHere(top, ["update-ref", "--stdin"], INLINE_EXEC_MS, `${lines.join("\n")}\n`);
      return put.exitCode === 0 ? undefined : gitSaid(put);
    } finally {
      const left = await ctx.gitHere(top, ["for-each-ref", "--format=delete %(refname)", incoming]);
      if (left.stdout.trim() !== "") await ctx.gitHere(top, ["update-ref", "--stdin"], INLINE_EXEC_MS, left.stdout);
    }
  };
  /** A folder's name as one part of a ref: what git refuses in a ref name turned to a dash. */
  const refPart = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.\.+/g, "-").replace(/^[.-]+|\.lock$|\.$/g, "") || "copy";
  /** The last line git said, stderr first, for a sentence that quotes it. */
  const lastLine = (res: { stdout: string; stderr: string }): string => (res.stderr.trim() || res.stdout.trim()).split("\n").at(-1) ?? "";
  /** What git said went wrong: its first error or fatal line, not a hint printed under it, else its last line. */
  const gitSaid = (res: { stdout: string; stderr: string }): string => res.stderr.split("\n").find(l => /^(error|fatal): /.test(l))?.trim() ?? lastLine(res);
  /** Whether a path is the folder or inside it. */
  const under = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
  /** Every worktree of a repo as git lists it now, read each time: the person and their agents add and remove their
   * own, so nothing here is kept. */
  const worktreesOf = async (top: string): Promise<{ path: string; branch?: string }[]> => {
    const read = await ctx.gitHere(top, ["worktree", "list", "--porcelain"]);
    if (read.exitCode !== 0) return [];
    const trees: { path: string; branch?: string }[] = [];
    for (const line of read.stdout.split("\n")) {
      if (line.startsWith("worktree ")) trees.push({ path: line.slice("worktree ".length) });
      else if (line.startsWith("branch refs/heads/") && trees.length > 0) trees[trees.length - 1]!.branch = line.slice("branch refs/heads/".length);
    }
    return trees;
  };
  return {
    projectFolder, worktreeFolder, folderFor, queued, removeWorktree, refuseChanged, dropCheckpoints, holdsThread,
    worktreeGone, runsIn, armSweep, moveOldCopies, gitSaid, worktreesOf, worktreeMounted, takeSetupLine,
  };
}
