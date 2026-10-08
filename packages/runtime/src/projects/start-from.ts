// SPDX-License-Identifier: AGPL-3.0-only
import type { ProjectView, Caller } from "@wsp/protocol";
import { GitPrReadReply, GitUpdateReply, GitStartOnReply, isPullRequestFact } from "@wsp/protocol";
import { noBranchesLine, PR_BEHIND_WORDS, copiesFolder, kindForComputer, placeBranchLine, runsInFolder, startPicks, HERE_PLACE_ID } from "@wsp/protocol";
import { holdsRepo, projectForRepo } from "@wsp/protocol";
import { accessWordRefusal, type AccessChoice, pickRefusal } from "@wsp/protocol";
import { HARNESS_CATALOGS, harnessCatalog } from "../harness-catalog.js";
import { GitIssueReadReply, GitPrDiffReply, START_WORDS, isReviewRead, lineInDiff, reviewFromReply, reviewReaskPrompt, startName, takenNameAfter, type IssueRead, PullRequest, type StartResult, type WorkspaceFrom } from "@wsp/protocol";
import type { StartPicksAsked } from "../types/harness.js";
import { type LiveWorkspace, CLONE_MS } from "../types/wiring.js";
import type { RuntimeContext, StartFromArea } from "../context.js";

export function startFromArea(ctx: RuntimeContext): StartFromArea {
  const { bus, clock, live, projectsHeld } = ctx;
  /** The project a GitHub repository names: the one whose remote is that repository, this computer's where two
   * computers hold it, or the one named by name or id among them. A link is only ever matched to a project the
   * person added, and every later call names the repository off that project's record. */
  const projectByRepo = (repo: string, named: string | undefined): ProjectView => {
    const held = [...projectsHeld.values()];
    const picked = named === undefined ? projectForRepo(held, repo, HERE_PLACE_ID) : held.find(p => holdsRepo(p, repo) && (p.id === named || p.name === named));
    if (picked === undefined) throw Object.assign(new Error(START_WORDS.noProjectForRepo(repo)), { kind: "invalid" });
    return picked;
  };

  /** An issue, or a pull request read as the issue it also is, on this computer's own git host command line. */
  const issueOf = async (remote: string, number: number): Promise<IssueRead> =>
    GitIssueReadReply.parse(await ctx.onThisComputer((ask, home) => ask({ op: "git.issueRead", cwd: home, remote, number }))).issue;

  /** A pull request by number, read in full on this computer. */
  const pullRequestOf = async (remote: string, number: number): Promise<PullRequest> => {
    const read = GitPrReadReply.parse(await ctx.onThisComputer((ask, home) => ask({ op: "git.prRead", cwd: home, remote, number }))).pr;
    if (read === undefined) throw new Error(`#${number} is not a pull request`);
    return read;
  };

  /** Where the work came from, off the link's kind and what was read. */
  const fromOf = (kind: WorkspaceFrom["kind"], repo: string, read: IssueRead, fact: PullRequest | undefined): WorkspaceFrom => ({
    kind,
    repo,
    number: read.number,
    url: read.url,
    title: read.title,
    ...(fact !== undefined
      ? { base: fact.base, head: { branch: fact.branch, oid: fact.headOid, ...(fact.fork !== undefined ? { fork: fact.fork } : {}) } }
      : {}),
  });

  /** A workspace made for a start or a review: the copy made by the create road, where the work came from on its
   * record, and for a pull request its base, its pull request and its head, the copy put on the head branch through
   * its own daemon. A checkout that is refused takes the half-made workspace with it and answers its own sentence. */
  const workspaceFrom = async (project: ProjectView, from: WorkspaceFrom, fact: PullRequest | undefined, kind: "start" | "review", origin: Caller | undefined): Promise<LiveWorkspace> => {
    const at = ctx.kindOf(project.computer);
    if (copiesFolder(at)) return folderFrom(project, from, fact);
    // A folder on a computer the person joined: an issue runs in the project folder, and a pull request's head waits
    // on a worktree there, which wsp does not make yet.
    if (runsInFolder(at)) {
      if (fact !== undefined) throw Object.assign(new Error(placeBranchLine(ctx.placeName(project.computer))), { kind: "usage" });
      return ctx.projectFolder(project);
    }
    const taken = new Set([...live.values()].map(e => e.record.name));
    const name = takenNameAfter(startName(kind, from.number, from.title), taken);
    const made = await ctx.workspaces.create({ project: project.id, name }, origin);
    const entry = live.get(made.id);
    if (entry === undefined) throw new Error(`${name} was made and then not found`);
    entry.record.from = from;
    if (fact !== undefined) {
      entry.record.base = fact.base;
      entry.record.pr = { number: fact.number, url: fact.url, state: fact.state, base: fact.base };
      entry.pr = { ...fact, readAt: clock.now() };
    }
    await ctx.persist(entry.record);
    if (fact !== undefined) {
      try {
        await ctx.withDaemon(entry, ask => ask({ op: "git.prCheckout", cwd: ctx.checkoutOf(entry.record), number: fact.number }));
      } catch (e) {
        await ctx.workspaces.delete(entry.record.id, origin).catch((d: unknown) => console.warn(`${name} was not taken back after its checkout failed: ${d instanceof Error ? d.message : String(d)}`));
        throw e;
      }
    }
    return entry;
  };

  /** Where a start or a review on this computer runs: an issue in the project folder; a pull request in a worktree on
   * its head, fetched into the project's repo first as a branch of its own where none of that name stands, so
   * nothing moves the project folder's checkout. The pull request's facts go on the worktree's record alone. */
  const folderFrom = async (project: ProjectView, from: WorkspaceFrom, fact: PullRequest | undefined): Promise<LiveWorkspace> => {
    if (fact === undefined) return ctx.projectFolder(project);
    const top = project.git?.top;
    if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
    const branch = fact.fork === undefined ? fact.branch : `${fact.fork.owner}/${fact.branch}`;
    // A branch some worktree already holds runs there and is caught up below; any other is fetched first, made where
    // it is not here and only moved forward where it is, never forced.
    const holds = (await ctx.worktreesOf(top)).some(w => w.branch === branch);
    if (!holds) await fetchHead(project, top, fact, branch);
    const entry = await ctx.worktreeFolder(project, top, branch);
    if (holds) {
      const behind = await catchUp(entry, project, top, fact);
      if (behind !== undefined) behindOn.set(entry.record.id, behind);
    }
    if (entry.record.worktree === undefined) return entry;
    entry.record.from = from;
    entry.record.base = fact.base;
    entry.record.pr = { number: fact.number, url: fact.url, state: fact.state, base: fact.base };
    entry.pr = { ...fact, readAt: clock.now() };
    await ctx.persist(entry.record);
    return entry;
  };

  /** A start's picks read against the agent's lists before a folder is made or moved for it, by the rule the start
   * itself refuses them with, so a pick the agent does not take costs no git work. */
  const picksHold = async (project: ProjectView, o: StartPicksAsked): Promise<void> => {
    if (!copiesFolder(kindForComputer(project.computer))) return;
    const home = await ctx.projectFolder(project);
    const prefs = ctx.state.preferencesHeld ?? (await ctx.preferences.get());
    const harness = o.harness ?? ctx.defaultAgentOf(prefs, home);
    const table = harnessCatalog(harness);
    if (table === undefined) return;
    const { adapter } = await ctx.launchAdapterFor(home, harness);
    const resolved = ctx.defaultsOn(await ctx.catalogOn(table, home, adapter), prefs, prefs.projectDefaults[home.record.project]);
    // This road is the command line's and the tools', so it names the flag to drop; namedMode speaks for the app too.
    const refused = o.access === undefined ? null : accessWordRefusal(resolved.catalog, o.access);
    if (refused !== null) throw refused;
    const named = o.permissionMode ?? (o.access === undefined ? undefined : ctx.namedMode(resolved.catalog, harness, o.access));
    const model = o.model ?? resolved.open.model;
    const effort = o.effort ?? resolved.open.effort;
    try {
      startPicks(resolved.catalog, { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(named !== undefined ? { permissionMode: named } : {}), ...(o.fast === true ? { fast: true } : {}) }, true);
    } catch (e) {
      throw pickRefusal(e, resolved.catalog);
    }
  };

  /** The line a start on a pull request leaves for its thread, by the record of the folder that was left behind. */
  const behindOn = new Map<string, string>();
  /** The project folder's record with this computer's daemon told the folder is its to work in, so an ask naming a
   * project anywhere a project may live resolves. */
  const askingIn = async (entry: LiveWorkspace): Promise<LiveWorkspace> => {
    await ctx.writeDaemonRoots(entry);
    return entry;
  };
  /** A pull request's head into its local branch through the daemon: the branch by name where the remote still holds
   * it, else the pull request's own head, which outlives a branch deleted at the merge. GitHub serves a fork's head
   * on the base repository as pull/<n>/head, so no fork's URL is dialled. */
  const fetchHead = async (project: ProjectView, top: string, fact: PullRequest, branch: string): Promise<void> => {
    if (fact.fork === undefined) {
      const home = await askingIn(await ctx.projectFolder(project));
      try {
        GitStartOnReply.parse(await ctx.withDaemon(home, ask => ask({ op: "git.fetchBranch", cwd: project.path, remote: project.remote, branch: fact.branch, into: branch })));
        return;
      } catch (e) {
        if (await remoteHolds(top, project.remote, `refs/heads/${fact.branch}`)) throw e;
      }
    }
    const fetched = await ctx.gitHere(top, ["fetch", "--quiet", "--no-tags", project.remote, `pull/${fact.number}/head:refs/heads/${branch}`], CLONE_MS);
    if (fetched.exitCode !== 0) throw new Error(ctx.gitSaid(fetched));
  };
  /** Whether the remote holds a ref; exit 2 alone is its answer that it does not. */
  const remoteHolds = async (top: string, remote: string, ref: string): Promise<boolean> =>
    (await ctx.gitHere(top, ["ls-remote", "--exit-code", remote, ref], CLONE_MS)).exitCode !== 2;
  /** The folder holding a pull request's branch, caught up where it may be: a worktree wsp made that is clean and
   * only behind moves forward through the daemon; the project folder never moves, and any folder left as it stands
   * gets the line its thread is told. */
  const catchUp = async (entry: LiveWorkspace, project: ProjectView, top: string, fact: PullRequest): Promise<string | undefined> => {
    const path = entry.record.worktree?.path ?? top;
    const byName = fact.fork === undefined && (await remoteHolds(top, project.remote, `refs/heads/${fact.branch}`));
    const spec = byName ? `refs/heads/${fact.branch}` : `pull/${fact.number}/head`;
    const fetched = await ctx.gitHere(top, ["fetch", "--quiet", "--no-tags", project.remote, spec], CLONE_MS);
    if (fetched.exitCode !== 0) return PR_BEHIND_WORDS.unread(fact.number, ctx.gitSaid(fetched));
    const head = (await ctx.gitHere(top, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
    const at = (await ctx.gitHere(path, ["rev-parse", "HEAD"])).stdout.trim();
    if (head === at || (await ctx.gitHere(path, ["merge-base", "--is-ancestor", head, at])).exitCode === 0) return undefined;
    if ((await ctx.gitHere(path, ["merge-base", "--is-ancestor", at, head])).exitCode !== 0) return PR_BEHIND_WORDS.diverged(fact.number, path);
    if ((await ctx.gitHere(path, ["status", "--porcelain"])).stdout.trim() !== "") return PR_BEHIND_WORDS.changed(fact.number, path);
    if (entry.record.worktree === undefined) return PR_BEHIND_WORDS.folder(fact.number, path);
    if (entry.record.worktree.made !== true) return PR_BEHIND_WORDS.notMade(fact.number, path);
    if (!byName) return PR_BEHIND_WORDS.byHead(fact.number, path, project.remote);
    try {
      GitUpdateReply.parse(await ctx.withDaemon(await askingIn(entry), ask => ask({ op: "git.update", cwd: ctx.checkoutOf(entry.record), base: fact.branch })));
      return undefined;
    } catch (e) {
      return PR_BEHIND_WORDS.unread(fact.number, e instanceof Error ? e.message : String(e));
    }
  };

  /** The thread a start or a review opens, detached: the turn goes on without the caller. */
  const openWith = async (entry: LiveWorkspace, o: { prompt: string; harness?: string; model?: string; effort?: string; permissionMode?: string; access?: AccessChoice }, origin: Caller | undefined): Promise<StartResult> => {
    const behind = behindOn.get(entry.record.id);
    behindOn.delete(entry.record.id);
    const handle = await ctx.sessionsApi.start(
      entry.record.id,
      {
        ...(behind !== undefined ? { behind } : {}),
        prompt: o.prompt,
        ...(o.harness !== undefined ? { harness: o.harness } : {}),
        ...(o.model !== undefined ? { model: o.model } : {}),
        ...(o.effort !== undefined ? { effort: o.effort } : {}),
        ...(o.permissionMode !== undefined ? { permissionMode: o.permissionMode } : {}),
        ...(o.access !== undefined ? { access: o.access } : {}),
      },
      origin,
    );
    const v = handle.view();
    return { workspace: ctx.view(entry.record), threadId: v.threadId ?? v.id, sessionId: v.id };
  };

  /** The harnesses whose table names a mode that changes nothing, which are the ones that can review. */
  const readOnlyOf = (agent: string): string | undefined => HARNESS_CATALOGS.find(c => c.harness === agent)?.readOnlyMode;
  const reviewers = (): string[] => {
    const all = HARNESS_CATALOGS.filter(c => c.readOnlyMode !== undefined).map(c => c.harness);
    // Codex first: the owner's rule since 2026-09-26 is that Codex runs reviews.
    return [...all.filter(h => h === "codex"), ...all.filter(h => h !== "codex")];
  };

  /** A reviewer's reply read at its turn's end: the review its last fenced json block writes becomes the draft, each
   * comment on a line outside the diff marked for the summary; a reply with no block that reads is asked once more
   * in the same thread, and a second that does not read leaves the sentence. A reply with no block after a draft that
   * read leaves that draft as it was: the person may have asked the reviewer something else. */
  const takeReview = async (entry: LiveWorkspace, threadId: string, text: string): Promise<void> => {
    const from = entry.record.from;
    if (from?.kind !== "review") return;
    const read = reviewFromReply(text);
    const prior = entry.record.review;
    const at = clock.now();
    if (!read.ok) {
      if (isReviewRead(prior)) return;
      const reasked = prior !== undefined && "note" in prior && prior.reasked === true;
      entry.record.review = { note: read.why, at, reasked: true };
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.review", workspaceId: entry.record.id });
      if (!reasked) void ctx.sendDetached(entry.record.id, { prompt: reviewReaskPrompt(read.why), thread: threadId }, undefined).catch((e: unknown) => console.warn(`the reviewer of ${entry.record.name} was not asked again: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    const remote = ctx.projectHeld(entry.record.project).remote;
    const diff = await ctx.onThisComputer((ask, home) => ask({ op: "git.prDiff", cwd: home, remote, number: from.number })).then(
      r => GitPrDiffReply.parse(r).diff,
      () => undefined,
    );
    const comments = read.review.comments.map((c, n) => ({
      id: `c${n + 1}`,
      ...c,
      on: true,
      ...(diff !== undefined && lineInDiff(diff, c.path, c.line, c.side) === false ? { inSummary: true } : {}),
    }));
    const headOid = (isPullRequestFact(entry.pr) ? entry.pr.headOid : undefined) ?? from.head?.oid ?? "";
    entry.record.review = { verdict: read.review.verdict, summary: read.review.summary, comments, headOid, threadId, at };
    await ctx.persist(entry.record);
    bus.emit({ type: "workspace.review", workspaceId: entry.record.id });
  };
  return {
    projectByRepo, issueOf, pullRequestOf, fromOf, workspaceFrom, picksHold, openWith, readOnlyOf, reviewers,
    takeReview,
  };
}
