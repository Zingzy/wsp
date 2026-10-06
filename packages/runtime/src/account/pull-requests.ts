// SPDX-License-Identifier: AGPL-3.0-only
import { gitHostOf, remoteHost } from "@wsp/catalog";
import { type DaemonFrame, type Caller, GitPrReadReply, GitPrViewReply, GitRepoReadReply, GitUpdateReply, type TreeRecord, PR_POLL_MS, pullRequestPostLine, isPullRequestFact, noPullRequestRefusal, pullRequestStoppedLine, pullRequestUnreadLine, type PullRequestSeen, threadKeyOf, PR_POLL_IDLE_MS, isLocalWorkspace, PullRequest } from "@wsp/protocol";
import { SLATE_PR_POLL_MS, CHECKOUT_TTL_MS, PR_PAGE_HOLD_MS, RATE_LIMIT_HOLD_MS } from "../types/events.js";
import type { LiveWorkspace } from "../types/wiring.js";
import { DaemonRefusal, isNoHostCli } from "../types/internal.js";
import type { RuntimeContext, PullRequestsArea } from "../context.js";

export function pullRequestsArea(ctx: RuntimeContext): PullRequestsArea {
  const { clock, githubCache, live, sessions } = ctx;
  /** Whether a workspace's copy can read the git host itself where this computer cannot: one on a machine of its own,
   * running. A copy on this computer runs this computer's command line, and a stopped one is never woken for a read. */
  const copyReadsHost = (entry: LiveWorkspace): boolean => !isLocalWorkspace(entry.record) && entry.record.phase === "running";

  /** One read of the git host for a workspace: on this computer, then through the copy's own daemon where this computer
   * has no signed-in command line for the host and the copy can read it. The frame names the remote off the project's
   * record on either road, never the copy's own configuration, which the agent writes. The copy's gh is on a PATH its
   * agent can write, so a read through it is the agent's word: a forged merged there settles the tree and naps its
   * machine, and nothing past that, which is why a merge never takes this road. */
  const readHost = async <T>(entry: LiveWorkspace, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T): Promise<T> =>
    (await readHostOn(entry, frame, parse)).read;

  /** The same read, saying whether it was this computer's own command line that answered. What it answers is held
   * by remote and number alone, since this computer's command line answers it wherever one is signed in here. */
  const readHostOn = async <T>(entry: LiveWorkspace, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T): Promise<{ read: T; here: boolean }> => {
    try {
      return { read: await heldOff("here", () => ctx.onThisComputer(async (ask, home) => parse(await ask(frame(home))))), here: true };
    } catch (e) {
      if (!isNoHostCli(e) || !copyReadsHost(entry)) throw e;
    }
    return { read: await heldOff(entry.record.id, () => ctx.withDaemon(entry, async ask => parse(await ask(frame(ctx.checkoutOf(entry.record)))))), here: false };
  };

  /** The git host's rate limit refusal, by the road whose command line met it: this computer's, or a copy's. A road
   * that met one answers every read with it for RATE_LIMIT_HOLD_MS rather than running its command line against an
   * empty budget once per pane open. gh's refusal names no reset, so the hold does not end at one. */
  const rateLimited = new Map<string, { until: number; refusal: unknown }>();
  const heldOff = async <T>(road: string, read: () => Promise<T>): Promise<T> => {
    const held = rateLimited.get(road);
    if (held !== undefined && clock.now() < held.until) throw held.refusal;
    try {
      return await read();
    } catch (e) {
      if (e instanceof DaemonRefusal && e.code === "rate-limited") rateLimited.set(road, { until: clock.now() + RATE_LIMIT_HOLD_MS, refusal: e });
      throw e;
    }
  };

  /** The workspace with the pull request it has, by number, and its project's remote; refused where it has none. */
  const pullRequestOn = async (workspaceId: string, origin: Caller | undefined): Promise<{ entry: LiveWorkspace; remote: string; number: number }> => {
    const entry = await ctx.entryOf(workspaceId, origin);
    const number = entry.record.pr?.number;
    if (number === undefined) throw new Error(noPullRequestRefusal(entry.record.name));
    return { entry, remote: ctx.projectHeld(entry.record.project).remote, number };
  };

  const pageKey = (remote: string, number: number): string => `page:${remote}#${number}`;

  /** A pull request's page, held PR_PAGE_HOLD_MS per remote and number so a pane reopened or remounted within it reads
   * nothing; a refresh asks fresh, and every write as the person drops what is held. */
  const readPage = async (entry: LiveWorkspace, remote: string, number: number, fresh: boolean): Promise<{ page: GitPrViewReply; here: boolean }> => {
    const key = pageKey(remote, number);
    const held = fresh ? undefined : githubCache.get(key);
    if (held !== undefined && clock.now() - held.fetchedAt < PR_PAGE_HOLD_MS) return held.body as { page: GitPrViewReply; here: boolean };
    const fetchedAt = clock.now();
    const { read: page, here } = await readHostOn(entry, cwd => ({ op: "git.prView", cwd, remote, number }), r => GitPrViewReply.parse(r));
    githubCache.set(key, { body: { page, here }, fetchedAt });
    clock.schedule(() => githubCache.get(key)?.fetchedAt === fetchedAt && githubCache.delete(key), PR_PAGE_HOLD_MS, { unref: true });
    return { page, here };
  };

  /** A write on the git host as the person, through this computer's own signed-in command line alone, as a merge and
   * a review post are: a copy's gh sits on a PATH its agent can write, so nothing posts as the person through it. */
  const postAsPerson = async <T>(remote: string, number: number, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T): Promise<T> => {
    githubCache.delete(pageKey(remote, number));
    try {
      return await ctx.onThisComputer(async (ask, home) => parse(await ask(frame(home))));
    } catch (e) {
      if (isNoHostCli(e)) throw new Error(pullRequestPostLine(hostOfRemote(remote)));
      throw e;
    }
  };

  /** The host a project's remote lives on, as a sentence about its command line names it. */
  const hostOfRemote = (remote: string): string => gitHostOf(remote)?.sshHosts[0] ?? remoteHost(remote) ?? remote;

  /** How often an open pull request is read again: PR_POLL_MS while a window is open, PR_POLL_IDLE_MS while none is. */
  const prPollMs = (): number => (ctx.status.watched() ? PR_POLL_MS : PR_POLL_IDLE_MS);

  const prKey = (remote: string, number: number): string => `pr:${remote}#${number}`;

  /** The workspace's pull request read through the git host's command line, kept on the entry and pushed on its status:
   * on view, at a turn's end, after a bring back, a merge, a fix and an update, and on a timer while it is open. An
   * open one known by number is read by number with what its last read saw, so an unchanged one costs one REST read
   * and runs nothing else, unless the caller asks for the whole; otherwise it is read by the copy's branch, and a
   * branch that had none is not read again on view until its head moves. A merged or closed one is never read again. On view an open one read
   * within the poll interval answers as held, since its timer keeps it, and anything else within CHECKOUT_TTL_MS. A
   * read the host refused for any reason but a missing command line keeps the last fact, whose time says how old it is. */
  const readPullRequest = (entry: LiveWorkspace, force: boolean, whole = false): Promise<PullRequestSeen | undefined> => {
    const kept = entry.record.pr;
    if (kept !== undefined && kept.state !== "open") return Promise.resolve(entry.pr);
    const held = entry.pr;
    const hold = isPullRequestFact(held) ? prPollMs() : CHECKOUT_TTL_MS;
    if (!force && held !== undefined && clock.now() - held.readAt < hold) {
      // A window opened or closed since the timer was armed: it reads at the interval now in force, from the last read.
      if (isPullRequestFact(held) && entry.prPoll !== undefined && entry.prPollMs !== hold) pollPullRequest(entry, held.readAt);
      return Promise.resolve(held);
    }
    if (!force && kept === undefined && entry.prNoneAt !== undefined && entry.prNoneAt === entry.checkout?.head) return Promise.resolve(held);
    if (entry.prReading !== undefined && !whole) return entry.prReading;
    const reading = (async (): Promise<PullRequestSeen | undefined> => {
      const project = ctx.projectHeld(entry.record.project);
      if (project.remote === "") return entry.pr;
      const checkout = kept === undefined ? (entry.checkout ?? (await ctx.readCheckout(entry, false))) : undefined;
      const branch = checkout?.branch;
      const base = entry.record.base ?? project.base;
      if (kept === undefined && (branch === undefined || branch === base || branch.startsWith("("))) return entry.pr;
      const cached = kept !== undefined ? githubCache.get(prKey(project.remote, kept.number)) : undefined;
      const body = PullRequest.safeParse(cached?.body);
      // A check finishing moves nothing of what is seen, so one still running, or an ask for the whole, reads in full.
      const seen = !whole && body.success && cached?.tag !== undefined && !body.data.checks.some(c => c.state === "pending") ? cached.tag : undefined;
      const at = clock.now();
      try {
        const read = await readHost(
          entry,
          cwd => ({ op: "git.prRead", cwd, remote: project.remote, ...(kept !== undefined ? { number: kept.number } : { branch }), ...(seen !== undefined ? { seen } : {}) }),
          r => GitPrReadReply.parse(r),
        );
        if (read.unchanged === true && body.success) {
          await takePullRequest(entry, { ...body.data, readAt: at });
          return entry.pr;
        }
        const pr = read.pr;
        if (pr !== undefined && read.seen !== undefined) githubCache.set(prKey(project.remote, pr.number), { body: pr, tag: read.seen, fetchedAt: at });
        if (pr === undefined && kept === undefined) entry.prNoneAt = checkout?.head;
        else delete entry.prNoneAt;
        await takePullRequest(entry, pr === undefined ? undefined : { ...pr, readAt: at });
      } catch (e) {
        if (isNoHostCli(e)) {
          const host = hostOfRemote(project.remote);
          const stopped = !isLocalWorkspace(entry.record) && entry.record.phase !== "running";
          await takePullRequest(entry, { why: stopped ? pullRequestStoppedLine(host, entry.record.name) : pullRequestUnreadLine(host), readAt: at });
        } else pollPullRequest(entry);
      }
      return entry.pr;
    })().finally(() => {
      delete entry.prReading;
    });
    entry.prReading = reading;
    return reading;
  };

  /** A pull request just read, onto the entry and the status, the record following it where it moved, the timer set
   * for an open one, and the tree settled where it merged or closed. */
  const takePullRequest = async (entry: LiveWorkspace, seen: PullRequestSeen | undefined): Promise<void> => {
    entry.pr = seen;
    if (isPullRequestFact(seen)) {
      const was = entry.record.pr;
      if (was === undefined || was.state !== seen.state || was.number !== seen.number) {
        const settledAt = seen.state === "merged" ? { mergedAt: seen.readAt } : seen.state === "closed" ? { closedAt: seen.readAt } : {};
        // What was sent belongs to the pull request it was read off; another one starts with nothing sent.
        if (was !== undefined && was.number !== seen.number) delete entry.record.prSent;
        // A settled one is never read again, so the checks the read that saw it settle found are the ones it keeps.
        const checks = seen.state !== "open" ? { checks: seen.checks } : {};
        entry.record.pr = { number: seen.number, url: seen.url, state: seen.state, base: seen.base, ...settledAt, ...checks };
        await ctx.persist(entry.record);
      }
    }
    await ctx.statusNow(entry);
    pollPullRequest(entry);
    if (entry.record.pr !== undefined && entry.record.pr.state !== "open") await settleTree(entry);
  };

  /** The one timed read an open pull request waits on; nothing is armed for a merged or closed one, which is never
   * read again. */
  const pollPullRequest = (entry: LiveWorkspace, from = clock.now()): void => {
    entry.prPoll?.();
    delete entry.prPoll;
    const fact = entry.pr;
    if (!isPullRequestFact(fact) || fact.state !== "open" || live.get(entry.record.id) !== entry) return;
    // A slate bound to the checks reads a pending one every 30 s rather than at the idle or watched pace (06-sources).
    const pending = fact.checks.some(c => c.state === "pending") && ctx.slates.watchesPr(entry.record.id);
    const ms = pending ? SLATE_PR_POLL_MS : prPollMs();
    entry.prPollMs = ms;
    entry.prPoll = clock.schedule(
      () => {
        delete entry.prPoll;
        void readPullRequest(entry, true);
      },
      Math.max(0, from + ms - clock.now()),
      { unref: true },
    );
  };

  /** What a child's record keeps of the tree, written and read again on its lead's rows. */
  const keepTree = async (child: LiveWorkspace, kept: TreeRecord): Promise<void> => {
    if (Object.keys(kept).length === 0) delete child.record.tree;
    else child.record.tree = kept;
    await ctx.persist(child.record);
    ctx.readLeadOf(child);
  };

  /** A root workspace's tree once its pull request merged or closed: every thread of it, across every workspace it
   * spans, stamped read and settled where none of them is working, and its machine napped now rather than after its
   * quiet window. A workspace a thread opened settles nothing off its own pull request: only the root's counts. A tree
   * with a turn still running waits for that turn's end, which settles it then. Nothing is deleted. */
  const settleTree = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.parentThreadId !== undefined) return;
    const rows = [...sessions.values()].map(s => s.view);
    const roots = new Set(rows.filter(v => v.workspaceId === entry.record.id && v.rootThreadId === undefined).map(v => threadKeyOf(v)));
    if (roots.size === 0) return;
    const tree = rows.filter(v => roots.has(threadKeyOf(v)) || (v.rootThreadId !== undefined && roots.has(v.rootThreadId)));
    if (tree.some(v => v.status === "running")) return;
    const at = clock.now();
    await ctx.mark([...new Set(tree.map(v => threadKeyOf(v)))], { readAt: at, settledAt: at }, undefined).catch((e: unknown) =>
      console.warn(`the tree of ${entry.record.name} was not settled: ${e instanceof Error ? e.message : String(e)}`),
    );
    if (ctx.pauses(entry.record) && entry.record.phase === "running") {
      void ctx.napWith(entry.record.id).catch((e: unknown) => console.warn(`${entry.record.name} was not napped once its pull request settled: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  /** The repository settings a merge reads, kept per remote for an hour: they change when a person edits the
   * repository, and a merge asks for them every time. */
  const repoSettings = new Map<string, { at: number; read: GitRepoReadReply }>();
  const REPO_SETTINGS_MS = 60 * 60_000;
  const mergeSettings = async (remote: string): Promise<GitRepoReadReply> => {
    const cached = repoSettings.get(remote);
    if (cached !== undefined && clock.now() - cached.at < REPO_SETTINGS_MS) return cached.read;
    const read = GitRepoReadReply.parse(await heldOff("here", () => ctx.onThisComputer((ask, home) => ask({ op: "git.repoRead", cwd: home, remote }))));
    repoSettings.set(remote, { at: clock.now(), read });
    return read;
  };

  /** The base's latest commits merged into the copy's branch through the copy's own daemon, the base read as a bring
   * back reads it; then the branch line read again, and the pull request, whose word a conflict or a count may move. */
  const updateCopy = async (entry: LiveWorkspace): Promise<GitUpdateReply> => {
    const base = entry.record.base ?? ctx.projectHeld(entry.record.project).base;
    const done = GitUpdateReply.parse(await ctx.queued(entry.record.id, () => ctx.withDaemon(entry, ask => ask({ op: "git.update", cwd: ctx.checkoutOf(entry.record), ...(base !== undefined ? { base } : {}) }))));
    await ctx.readCheckout(entry, true);
    void readPullRequest(entry, true);
    return done;
  };
  return {
    readHost, pullRequestOn, pageKey, readPage, postAsPerson, readPullRequest, takePullRequest, pollPullRequest,
    keepTree, settleTree, mergeSettings, updateCopy,
  };
}
