// SPDX-License-Identifier: AGPL-3.0-only
import { CATALOG_AGENTS, type ThreadAgent } from "@wsp/catalog";
import {
  AGENT_KEEP_MS, AGENTS_KEPT, type PermissionAsk, type SessionRenameWrite, type SessionView, type TurnResult,
  type Caller, SessionOrigin, ThreadScope, WorkspaceOrigin, GitDiffReply, GitWorktreesReply, repoPathOf, worktreeOf, foldThreads, threadWord, threadsFollowed, scopeOf,
  type ThreadWaitingOn, isLocalWorkspace, NO_SUCH_TURN, NOTIFY_ME, notifyLine, runsInFolder, DEVICE_OPS, sendRefusal,
  workspaceState, HERE_PLACE_ID, runningOn as runningOnPlace, type ThreadCapWait, roadOf, unreadLine, turnLines,
} from "@wsp/protocol";
import { harnessCatalog } from "../harness-catalog.js";
import { PLAN_RESETS, secretsOf } from "../adapters.js";
import { accountOf, accountOnComputer, resetDetailsDue, type Vaulted } from "../usage.js";
import type { WorkspaceRecord, LiveWorkspace, SessionHandle } from "../types/wiring.js";
import {
  RESTARTED_REASON, NOTIFY_OWED, readRoad, readScope, noCheckpointLogLine, type Taken, type TurnLive, type KeptProcess, type KeptLaunch, launchesAs,
  stampSessionFile, sameSessionFile, DaemonRefusal, type LiveSession, HELD_STARTS, type HeldStartRecord, writeLines,
} from "../types/internal.js";
import type { CapHeld, RuntimeContext, ThreadsArea } from "../context.js";

/** The row the person is told where a line falls, kept with the line so a host that restarts tells it too. */
type PersonRow = { workspaceId: string; sessionId: string; turnId: string; text: string };
/** A line into one thread, as the store keeps it until that thread takes it: a child's finished line, or a message
 * steered into the thread's turn that its agent never read, which goes as whoever opened it. */
type Owed = { id: string; from: string; notify: string; text: string; by?: ThreadScope; road?: WorkspaceOrigin; startedBy?: SessionOrigin; toPerson?: PersonRow };
/** A line on its way, with the road that tells the person where its thread's door refuses it. */
type Line = Owed & { fell?: () => void };
const readPersonRow = (raw: unknown): PersonRow | undefined => {
  const r = raw as Partial<Record<keyof PersonRow, unknown>> | undefined;
  return typeof r?.workspaceId === "string" && typeof r.sessionId === "string" && typeof r.turnId === "string" && typeof r.text === "string"
    ? { workspaceId: r.workspaceId, sessionId: r.sessionId, turnId: r.turnId, text: r.text }
    : undefined;
};
const readOwed = (raw: unknown): Owed | undefined => {
  const r = raw as Partial<Record<keyof Owed, unknown>> | undefined;
  if (typeof r?.id !== "string" || typeof r.from !== "string" || typeof r.notify !== "string" || typeof r.text !== "string") return undefined;
  const by = readScope(r.by);
  const road = readRoad(r.road);
  const startedBy = SessionOrigin.safeParse(r.startedBy);
  const toPerson = readPersonRow(r.toPerson);
  return {
    id: r.id, from: r.from, notify: r.notify, text: r.text,
    ...(by !== undefined ? { by } : {}), ...(road !== undefined ? { road } : {}),
    ...(startedBy.success ? { startedBy: startedBy.data } : {}), ...(toPerson !== undefined ? { toPerson } : {}),
  };
};

export function threadsArea(ctx: RuntimeContext): ThreadsArea {
  const { opts, bus, clock, deviceDoor, live, threadRecords, sessions } = ctx;
  /** Whether any row of the thread is running, the harness holding it or not: a start writes its row before the turn
   * reaches the machine, and that row is one, so this is the test for whether the thread is spoken for. turnRuns is
   * the same test keyed by workspace. */
  const threadRuns = (threadId: string): boolean => [...sessions.values()].some(s => s.view.threadId === threadId && s.view.status === "running");
  /** The thread's row whose turn is still reaching the machine, if it has one; there is never more than one. */
  const launchingOn = (threadId: string): { turnId: string; launch: Promise<void> } | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.launch !== undefined) return { turnId: s.turnId, launch: s.launch };
    }
    return undefined;
  };

  const runningOn = (threadId: string): LiveSession | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.view.status === "running" && s.handle !== undefined) return s as LiveSession;
    }
    return undefined;
  };
  /** The latest row of a thread, by its runtime id, across every workspace: a thread is named from anywhere. */
  const latestOn = (threadId: string): SessionView | undefined => {
    let latest: SessionView | undefined;
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && (latest === undefined || (s.view.startedAt ?? 0) >= (latest.startedAt ?? 0))) latest = s.view;
    }
    return latest;
  };
  /** Each thread's agent process kept up between its turns on this computer, by thread: what its launch fixed, which a
   * next turn has to match to run on it, and the turn token and device its environment still carries, which name the
   * thread for as long as the process is kept and are taken away when it goes. A thread's running turn holds its
   * process and is not in here; its end puts the process back. */
  const keptAgents = new Map<string, KeptProcess>();

  /** Ends one thread's kept process and takes its token and device away with it. */
  const reapKept = (threadId: string, o?: { now: true }): void => {
    const kept = keptAgents.get(threadId);
    if (kept === undefined) return;
    keptAgents.delete(threadId);
    endKept(threadId, kept, o);
  };
  const endKept = (threadId: string, kept: KeptProcess, o?: { now: true }): void => {
    kept.cancel();
    if (kept.scopeDeviceId !== undefined) void deviceDoor.revoke(kept.scopeDeviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
    void kept.agent.close(o).catch((e: unknown) => console.warn(`the kept agent of thread ${threadWord(threadId)} did not end: ${e instanceof Error ? e.message : String(e)}`));
  };

  /** The host's own writes into a harness session's file still going, by session. Their bytes land before the write
   * answers, so a send waits them out before it reads the file against a kept process's stamp. */
  const hostWrites = new Map<string, Promise<void>>();
  /** This host writes into a harness session's own file (a title, a rename): the processes kept on that session stamp
   * the file again once it is in, or the next send would read the host's own write as the person resuming the session
   * elsewhere. */
  const writeSession = (harnessSessionId: string, write: () => Promise<SessionRenameWrite>): Promise<SessionRenameWrite> => {
    const wrote = write().then(w => {
      if (w.kind !== "written") return w;
      for (const kept of keptAgents.values()) {
        if (kept.session !== harnessSessionId) continue;
        const file = stampSessionFile(kept.agent.sessionFile, kept.file?.path);
        if (file !== undefined) kept.file = file;
      }
      return w;
    });
    const settled: Promise<void> = Promise.all([hostWrites.get(harnessSessionId), wrote.catch(() => {})]).then(() => {
      if (hostWrites.get(harnessSessionId) === settled) hostWrites.delete(harnessSessionId);
    });
    hostWrites.set(harnessSessionId, settled);
    return wrote;
  };

  /** The process a thread's next turn runs on, taken out of the keep: only where it was launched exactly as this turn
   * would be, resumes the session this turn resumes, and nothing else wrote that session since its last turn (the
   * person resumed it in a terminal). Any other kept process of the thread is ended here, and the turn boots cold. */
  const takeKept = (threadId: string, launch: KeptLaunch | undefined, session: string | undefined): KeptProcess | undefined => {
    const kept = keptAgents.get(threadId);
    if (kept === undefined) return undefined;
    if (launch === undefined || !launchesAs(kept.launch, launch) || kept.session !== session || !sameSessionFile(kept.agent.sessionFile, kept.file)) {
      reapKept(threadId);
      return undefined;
    }
    keptAgents.delete(threadId);
    kept.cancel();
    return kept;
  };

  /** A turn's process put back in the keep once the turn is over: the thread's next send runs on it until the keep
   * runs out, the thread goes, or a seventh would be kept, which ends the one idle longest. Answers whether it was
   * kept, since the turn's token and device stay with the process only then. */
  const holdKept = (threadId: string, o: Omit<KeptProcess, "file" | "usedAt" | "cancel">): boolean => {
    if (ctx.state.closing || !threadRecords.has(threadId)) {
      void o.agent.close().catch(() => {});
      return false;
    }
    reapKept(threadId);
    const file = stampSessionFile(o.agent.sessionFile);
    const kept: KeptProcess = { ...o, ...(file !== undefined ? { file } : {}), usedAt: clock.now(), cancel: () => {} };
    const timer = clock.schedule(() => {
      if (keptAgents.get(threadId) === kept) reapKept(threadId);
    }, AGENT_KEEP_MS, { unref: true });
    kept.cancel = timer;
    keptAgents.set(threadId, kept);
    // A process that went on its own takes its token with it; nothing is left to close.
    void o.agent.exited.then(() => {
      if (keptAgents.get(threadId) !== kept) return;
      keptAgents.delete(threadId);
      kept.cancel();
      if (kept.scopeDeviceId !== undefined) void deviceDoor.revoke(kept.scopeDeviceId).catch(() => {});
    });
    while (keptAgents.size > AGENTS_KEPT) {
      const [oldest] = [...keptAgents].reduce((a, b) => (b[1].usedAt < a[1].usedAt ? b : a));
      reapKept(oldest);
    }
    return true;
  };

  /** The thread a request came out of, by the token that request's own launch environment carries: the row holding
   * that token beside its session id. Every token this host knows it minted into one turn's launch, so one no row
   * carries names a turn the caller is not, and it is refused rather than read as the person, which would send a
   * builder's report where nobody is waiting for it. */
  const threadOfToken = (token: string): string => {
    // Only a row still running answers: a turn the runtime ended from this side (a nap, a stop, a restart it could
    // not re-open) never reaches the exit that drops its token, and a token whose turn is over names nobody.
    for (const s of sessions.values()) if (s.turnToken === token && s.view.status === "running" && s.view.threadId !== undefined) return s.view.threadId;
    // A process kept between turns still holds the token its first turn was launched with.
    for (const [threadId, kept] of keptAgents) if (kept.turnToken === token) return threadId;
    throw new Error(NO_SUCH_TURN);
  };
  /** Every thread the tree under this one holds, whether or not anything on it is running: read off the parent each
   * thread's record and rows carry, level by level, so a thread that spawned a thread that spawned a thread is all of
   * it, one whose rows fell off a folder's cap included. */
  const treeUnder = (threadId: string): string[] => {
    const parents = new Map<string, string>();
    for (const { view } of sessions.values()) if (view.threadId !== undefined && view.parentThreadId !== undefined) parents.set(view.threadId, view.parentThreadId);
    for (const [id, record] of threadRecords) if (record.parentThreadId !== undefined) parents.set(id, record.parentThreadId);
    const found: string[] = [];
    let front = [threadId];
    for (let steps = parents.size + 1; steps > 0 && front.length > 0; steps--) {
      const next = [...parents].filter(([id, parent]) => front.includes(parent) && !found.includes(id) && id !== threadId).map(([id]) => id);
      found.push(...next);
      front = next;
    }
    return found;
  };
  /** Which threads a thread's own token reaches: every thread of its own tree, the lead that started it, the ones
   * beside it under that lead and the ones under itself, on whatever workspace each runs, read off the root every
   * row carries. Two trees on one workspace neither read nor drive each other, the person's own thread beside a
   * lead included, and anything crossing between them goes through the person. A caller that is no thread reaches
   * every thread this host holds; a row with no thread of its own is in nobody's tree and is hidden from every
   * thread. This sits beside the workspace rule rather than inside it: the tree, not the workspace, is what a
   * thread's token reaches for threads. */
  const drivesThread = (threadId: string | undefined, caller: Caller | undefined): boolean => {
    const scope = scopeOf(caller);
    if (scope === undefined) return true;
    return threadId !== undefined && ctx.rootOf(threadId) === scope.rootThreadId;
  };
  /** Which threads a caller may settle or restore: a thread's token itself and the threads under it, never its lead
   * or one beside it, whose fold is the person's; a caller that is no thread, any. */
  const settlesThread = (threadId: string, caller: Caller | undefined): boolean => {
    const scope = scopeOf(caller);
    return scope === undefined || threadId === scope.threadId || treeUnder(scope.threadId).includes(threadId);
  };
  /** What a thread is called, by the one rule every listing reads it by: its own rows folded, so a thread named in
   * another thread's row reads there exactly as it reads in the sidebar. */
  const threadTitle = (threadId: string): string => {
    const rows = [...sessions.values()].map(x => x.view).filter(v => v.threadId === threadId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return foldThreads(rows)[0]?.title ?? threadWord(threadId);
  };

  /** The prompt each thread is stopped on, whole, by thread id. The row carries the lead as a line; a thread whose
   * own call is waiting behind this one has to draw the question and answer it, so the question itself is kept here
   * for as long as it stands open. */
  const leadAsks = new Map<string, PermissionAsk>();

  /** Every turn held for its launch that its computer's threads at once has not let through yet, by turn id: the
   * computer it runs on, the running turns that wait on it and so lend it a slot, the order it came in, which is the
   * order those turns start in, a stop that reached it, and once it waits on a slot, what its row says and the two
   * ways the wait ends, a look again or a stop. Written down while it waits, so a host that restarts under it ends it
   * rather than leaving its caller waiting on a turn nobody holds. */
  const capHeld = new Map<string, CapHeld>();
  let capOrder = 0;
  let heldWrites: Promise<unknown> = Promise.resolve();
  const heldWrite = (write: () => Promise<void>): void => {
    heldWrites = heldWrites.then(write).catch((e: unknown) => console.warn(`a held start was not written down: ${e instanceof Error ? e.message : String(e)}`));
  };

  /** Each running turn that runs in another turn's slot, by turn id, with the turn whose slot it is. A turn in the
   * slot of one that ends holds a slot of its own from then: the turn that lent to the one that ended was following it
   * and works again, so two working agents never count as one. */
  const borrowed = new Map<string, string>();
  bus.on("*", e => {
    if (e.type !== "session.end" || e.turnId === undefined) return;
    borrowed.delete(e.turnId);
    for (const [turn, lender] of borrowed) if (lender === e.turnId) borrowed.delete(turn);
  });

  /** A start holds its thread: from here until it is let through it counts as no thread running and stands in line. */
  const capHold = (record: WorkspaceRecord, turnId: string, lender: string | undefined): void => {
    if (!capHeld.has(turnId)) capHeld.set(turnId, { placeId: ctx.placeIdOf(record), lenders: lender !== undefined ? [lender] : [], order: capOrder++ });
  };

  /** A running turn follows a thread whose next turn to run is held: that held turn may run in the follower's slot too,
   * since the follower works no more until it is through, and looks again now. */
  const capLend = (turnId: string, lender: string): void => {
    const held = capHeld.get(turnId);
    if (held === undefined || held.lenders.includes(lender)) return;
    held.lenders.push(lender);
    held.waiting?.wake();
  };

  /** What holds a turn on this workspace back now: its computer's threads at once, met by the slots its running
   * threads hold, and the turns there that came before this one and are not through yet. A turn a running turn there
   * follows to its end runs in that turn's slot, one at a time, since the follower works no more until it ends; so a
   * chain of follows never waits on itself, and every other turn, a child started detached included, takes a slot of
   * its own. Nothing where there is room, and nothing on a cloud, whose cap counts machines. Synchronous, so a start
   * let through is counted before anything else looks. */
  const capFull = (record: WorkspaceRecord, turnId: string): ThreadCapWait | undefined => {
    const placeId = ctx.placeIdOf(record);
    const atOnce = placeId === undefined ? undefined : ctx.placeDoor?.threadsAt(placeId);
    const mine = capHeld.get(turnId);
    if (placeId === undefined || atOnce === undefined || mine === undefined) return undefined;
    const rows = [{ id: HERE_PLACE_ID, kind: "computer" as const }, ...(placeId === HERE_PLACE_ID ? [] : [{ id: placeId, kind: "computer" as const }])];
    const standing = [...live.values()].map(e => ({ ...e.record, provider: ctx.providerOf(e.record) }));
    const others = foldThreads([...sessions.values()].filter(s => s.turnId !== turnId && !capHeld.has(s.turnId)).map(s => s.view));
    const here = others.filter(t => runningOnPlace(placeId, rows, standing, [t]) > 0);
    const onHere = new Set(here.map(t => t.threadId ?? t.id));
    const runningHere = new Set([...sessions.values()].filter(s => s.view.status === "running" && s.view.threadId !== undefined && onHere.has(s.view.threadId)).map(s => s.turnId));
    const runsHere = (turn: string): boolean => runningHere.has(turn);
    const lent = [...borrowed].filter(([turn, lender]) => runsHere(turn) && runsHere(lender));
    const lender = mine.lenders.find(l => runsHere(l) && !lent.some(([, other]) => other === l));
    if (lender !== undefined) {
      borrowed.set(turnId, lender);
      return undefined;
    }
    const ahead = [...capHeld.entries()].filter(([id, h]) => id !== turnId && h.placeId === placeId && h.order < mine.order).length;
    return here.length - lent.length + ahead < atOnce ? undefined : { placeId, place: ctx.placeDoor!.nameOf(placeId), running: here.length, atOnce };
  };

  /** Holds a turn until a turn ends anywhere, a computer's settings change, a workspace is deleted or a held turn
   * leaves, any of which may free its slot or move the count its row says, so the caller looks again; said into the
   * thread's transcript as the wait begins and again whenever the count it says moved. Its machine is held awake
   * meanwhile, as a running turn holds it, so it is there to start on. Rejects with the stop's reason when the turn
   * is stopped, whether the stop came while it waited or before. */
  const capWait = (at: { workspaceId: string; threadId: string; turnId: string; sessionId: string; requestId?: string }, wait: ThreadCapWait): Promise<void> => {
    const held = capHeld.get(at.turnId) ?? { placeId: wait.placeId, lenders: [], order: capOrder++ };
    capHeld.set(at.turnId, held);
    if (held.stopped !== undefined) return Promise.reject(new Error(held.stopped));
    const said = held.waiting?.wait;
    const moved = said === undefined || said.running !== wait.running || said.atOnce !== wait.atOnce || said.place !== wait.place;
    if (held.waiting === undefined) {
      const row = sessions.get(at.turnId);
      const written: HeldStartRecord = {
        workspaceId: at.workspaceId, threadId: at.threadId, turnId: at.turnId, sessionId: at.sessionId, harness: row?.view.harness ?? "", place: wait.place,
        ...(row?.view.prompt !== undefined ? { prompt: row.view.prompt } : {}),
        ...(row?.notify !== undefined ? { notify: row.notify } : {}), ...(row?.notifyBy !== undefined ? { notifyBy: row.notifyBy } : {}), ...(row?.notifyRoad !== undefined ? { notifyRoad: row.notifyRoad } : {}),
      };
      heldWrite(() => ctx.store.put(HELD_STARTS, at.turnId, written));
    }
    ctx.idle.hold(at.workspaceId);
    return new Promise<void>((resolve, reject) => {
      let over = false;
      const end = (): void => {
        over = true;
        done();
        ctx.idle.release(at.workspaceId);
      };
      const wake = (): void => {
        if (over) return;
        end();
        resolve();
      };
      const done = bus.on("*", e => {
        if (e.type === "session.end" || e.type === "place.changed" || e.type === "workspace.deleted") wake();
      });
      held.waiting = {
        wait,
        wake,
        stop: reason => {
          if (over) return;
          end();
          reject(new Error(reason));
        },
      };
      if (moved) ctx.record({ type: "session.capped", workspaceId: at.workspaceId, sessionId: at.sessionId, turnId: at.turnId, threadId: at.threadId, ...wait, ...(at.requestId !== undefined ? { requestId: at.requestId } : {}) });
    });
  };

  /** Stops a held turn wherever it is between its hold and its launch: a wait it is in ends now, and a look it has not
   * made yet reads the mark and gives up, so a stop that lands between a wake and the next look is never lost. */
  const capStop = (turnId: string, reason: string): boolean => {
    const held = capHeld.get(turnId);
    if (held === undefined) return false;
    held.stopped = reason;
    held.waiting?.stop(reason);
    return true;
  };

  /** A stop on a turn is being read: until it is let go, the turn's next look waits for it, so a slot freeing while
   * the stop is still asking whether it may cannot let the turn through first. */
  const capStopping = (turnId: string): (() => void) => {
    const held = capHeld.get(turnId);
    if (held === undefined) return () => {};
    let done!: () => void;
    const asking = new Promise<void>(r => (done = r));
    (held.stops ??= new Set()).add(asking);
    return () => {
      held.stops?.delete(asking);
      done();
    };
  };

  /** A turn is let through or given up: every turn still waiting looks again, since its place in line or the count
   * its row says just moved. */
  const capLeft = (turnId: string): void => {
    const held = capHeld.get(turnId);
    if (held === undefined) return;
    capHeld.delete(turnId);
    if (held.waiting !== undefined) heldWrite(() => ctx.store.delete(HELD_STARTS, turnId));
    for (const other of [...capHeld.values()]) other.waiting?.wake();
  };

  /** The thread one running turn's calls are stopped behind, when one of them is a wsp call that follows another
   * thread to the end of its turn and that thread has an open prompt. A call that opened its own thread is behind
   * the whole tree under the caller, so a chain of agents waiting on each other names the one question at the
   * bottom of it: answering that is what moves any of them. */
  const stoppedBehind = (s: { view: SessionView; calls?: Map<string, { toolName: string; input: string }> }): ThreadWaitingOn | undefined => {
    const caller = s.view.threadId;
    if (caller === undefined || s.calls === undefined) return undefined;
    for (const call of s.calls.values()) {
      const follows = threadsFollowed(call);
      if (follows === undefined) continue;
      const behind: string[] = "opened" in follows ? treeUnder(caller) : [...sessions.values()].map(x => x.view.threadId).filter((id): id is string => id !== undefined && follows.named.some(ref => id.startsWith(ref)));
      for (const threadId of behind) {
        const prompt = leadAsks.get(threadId);
        if (prompt === undefined || threadId === caller) continue;
        const asked = [...sessions.values()].find(x => x.view.threadId === threadId && x.view.status === "running");
        if (asked === undefined) continue;
        return { threadId, workspaceId: asked.view.workspaceId, sessionId: asked.view.id, title: threadTitle(threadId), prompt: { ...prompt, options: [...prompt.options] } };
      }
    }
    return undefined;
  };

  /** Stops every running turn on the tree under a thread, deepest first, and answers with the threads it stopped. */
  const stopUnder = async (threadId: string, caller: Caller | undefined): Promise<string[]> => {
    const stopped: string[] = [];
    for (const child of treeUnder(threadId).reverse()) {
      const row = latestOn(child);
      if (row === undefined || row.status !== "running") continue;
      const outcome = await ctx.sessionsApi.interrupt(row.id, caller).catch((e: unknown) => {
        console.warn(`thread ${threadWord(child)} was not stopped with its root: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      if (outcome?.outcome === "accepted") stopped.push(child);
    }
    return stopped;
  };
  /** What the thread's start registered, kept by every turn on it: the targets, the thread that named them and the
   * road it named them from. */
  const notifyOn = (threadId: string): { notify: readonly string[]; by?: ThreadScope; road?: WorkspaceOrigin } | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.notify !== undefined) {
        return { notify: s.notify, ...(s.notifyBy !== undefined ? { by: s.notifyBy } : {}), ...(s.notifyRoad !== undefined ? { road: s.notifyRoad } : {}) };
      }
    }
    return undefined;
  };
  /** Whether a row can be told anything at all: it has a session to resume. A thread whose workspace went while its
   * builder worked has none, and the report must not go with it. The one predicate both roads read, the check before
   * a line is addressed and the send that carries it. */
  const tellable = (row: SessionView | undefined): row is SessionView => row?.claudeSessionId !== undefined;
  /** Every thread these targets lead to through the notify registrations: a thread's end tells its targets, and each
   * of those ends tells its own. Walked as a set, since two targets may lead to one thread and a chain that already
   * loops would otherwise be walked forever. */
  const notifyReach = (from: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = from.filter(target => target !== NOTIFY_ME);
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(notifyOn(at)?.notify ?? []).filter(target => target !== NOTIFY_ME));
    }
    return seen;
  };
  /** Lines for a parent whose workspace could not take a start when the child ended (napping, or the nap that ended
   * the child), sent when that workspace wakes; a host restart during the nap holds them again from the store. */
  const heldLines = new Map<string, Line[]>();
  /** The lines this host is carrying, by id, which the boot's pass over the store leaves to the road already on them. */
  const sending = new Set<string>();
  /** A line leaves the store once a turn of its thread took it, or once it fell to the person. */
  const owedTaken = (line: Line): void => {
    sending.delete(line.id);
    void ctx.store.delete(NOTIFY_OWED, line.id).catch((e: unknown) => console.warn(`the line of thread ${line.from.slice(0, 8)} into thread ${line.notify.slice(0, 8)} stays owed: ${e instanceof Error ? e.message : String(e)}`));
  };
  /** Who the lines off a row are delivered as: the thread that registered its targets and the road it registered
   * them from, read off the row that holds both so the two never drift apart. */
  const tellAs = (s: { notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin }): { by?: ThreadScope; road?: WorkspaceOrigin } => ({
    ...(s.notifyBy !== undefined ? { by: s.notifyBy } : {}),
    ...(s.notifyRoad !== undefined ? { road: s.notifyRoad } : {}),
  });
  /** The line into the parent thread as a send would go: steered into its running turn, or queued behind it, which
   * is what a parent still in its own reply tail gets, since the send road waits for that process rather than
   * refusing. It goes under the thread that named the target, so the switch on that thread's workspace and the
   * tree rule are read at delivery and not at registration alone; a line a person registered goes as the person's,
   * which is what every row written before the scope rode beside the targets carries. A parent with no session to
   * resume, and a start that door refuses, drop the line with a warning and call the line's own `fell`, which tells
   * the person the report is there; the child's end must not fail on either. */
  const deliver = (line: Line): void => {
    const { from, notify, text, by, road } = line;
    sending.add(line.id);
    const fell = (): void => {
      owedTaken(line);
      if (line.fell !== undefined) line.fell();
      else if (line.toPerson !== undefined) ctx.record({ type: "session.notify", ...line.toPerson, threadId: from, notify: NOTIFY_ME });
    };
    const parent = latestOn(notify);
    if (!tellable(parent)) {
      console.warn(`thread ${from.slice(0, 8)} ended, but thread ${notify.slice(0, 8)} has no session to tell`);
      fell();
      return;
    }
    // The line keeps the road that tells the person: a wake is minutes or hours later, and one the door refuses
    // then falls away exactly as one refused now does, once for the turn that ended.
    const holdForWake = (): boolean => {
      const phase = live.get(parent.workspaceId)?.record.phase;
      if (phase === undefined || sendRefusal(workspaceState({ phase })) === null) return false;
      heldLines.set(parent.workspaceId, [...(heldLines.get(parent.workspaceId) ?? []), line]);
      return true;
    };
    if (holdForWake()) return;
    // The road the targets were named from is read again here, where the line starts a turn: a device the person
    // paired may not start one, by the same list both doors read, so a row an older host wrote under that road
    // falls away to the person rather than starting a turn a paired socket could not.
    if (road === "paired" && !DEVICE_OPS.includes("sessions.start")) {
      console.warn(`thread ${from.slice(0, 8)} ended, but its line was registered from a paired computer, which starts no turn on thread ${notify.slice(0, 8)}`);
      fell();
      return;
    }
    // The caller this start runs under: the thread that registered the targets where one did, and the road it
    // registered them from. A line nobody but the person registered carries neither and goes as theirs, which is
    // what every row written before the road rode beside the targets holds.
    const asWho: Caller | undefined = by === undefined ? road : { origin: road ?? "here", by };
    // A start answers once the line steered the running turn or launched one of its own, which is when it is taken.
    ctx.sessionsApi.start(parent.workspaceId, { prompt: text, harness: parent.harness, thread: notify, startedBy: line.startedBy ?? "agent", ...(line.startedBy === undefined ? { wakesLead: true as const } : {}) }, asWho).then(() => {
      owedTaken(line);
      // A child's finished line is its whole report, so the lead that took it has read the child.
      if (line.startedBy === undefined) void ctx.mark([from], { readAt: clock.now() }, undefined).catch((e: unknown) => console.warn(`thread ${from.slice(0, 8)} was not marked read: ${e instanceof Error ? e.message : String(e)}`));
    }, (e: unknown) => {
      // A line queued behind the parent's turn meets the nap that ended that turn: it waits for the wake as well.
      if (holdForWake()) return;
      console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      fell();
    });
  };
  /** The messages steered into a turn that its agent never read, once the turn is over: each goes into the thread
   * again as its next message, in the words the row kept when it was steered, kept in the store as a child's line is,
   * under the caller that steered it and opened by whoever opened it, so the doors read it as a fresh steer and a nap
   * or a host restart keeps it. A turn the person stopped tells the person instead. An id the row does not hold is a
   * line on the run's input this host never wrote, and goes nowhere. */
  const sendBack = (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, ids: readonly string[], stopped: boolean): void => {
    const threadId = s.view.threadId;
    if (threadId === undefined) return;
    for (const id of ids) {
      const steered = s.turnLive?.steered?.[id];
      if (steered === undefined) continue;
      const { prompt, ...as } = steered;
      const toPerson: PersonRow = { workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, text: unreadLine(prompt) };
      if (stopped) {
        ctx.record({ type: "session.notify", ...toPerson, threadId, notify: NOTIFY_ME });
        continue;
      }
      const line: Owed = { id: `${s.turnId}:unread:${id}`, from: threadId, notify: threadId, text: prompt, ...as, toPerson };
      void ctx.store.put(NOTIFY_OWED, line.id, line).catch((e: unknown) => console.warn(`the message steered into thread ${threadId.slice(0, 8)} was not kept: ${e instanceof Error ? e.message : String(e)}`));
      deliver(line);
    }
  };
  // A wake or a rebuild (of a gone or zombie machine) puts the workspace back to running: the held lines go now.
  for (const type of ["workspace.woken", "workspace.upgraded"] as const) {
    bus.on(type, e => {
      if (e.type !== type) return;
      const lines = heldLines.get(e.workspaceId) ?? [];
      heldLines.delete(e.workspaceId);
      for (const l of lines) deliver(l);
    });
  }
  /** The one line an ending turn sends where its thread's start said: into a thread, or nowhere further for me, whom
   * the recorded event reaches. Recorded before the turn's session.done, since a follower ends there; the person's
   * own row for a line the target's door refused is the exception, since that answer comes after the start it made. */
  const notifyEnd = (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, notify: readonly string[], named: { by?: ThreadScope; road?: WorkspaceOrigin }, result: TurnResult): void => {
    const threadId = s.view.threadId;
    if (threadId === undefined) return;
    // A target whose thread has gone by now cannot be told, and its report must not go with it: the person is told
    // instead, once, however many targets fell away.
    const reachable = notify.filter(target => target === NOTIFY_ME || tellable(latestOn(target)));
    const targets = reachable.length === notify.length ? notify : [...new Set([...reachable, NOTIFY_ME])];
    let toldThePerson = targets.includes(NOTIFY_ME);
    // The same road for a line the target's own door refused, which the start answers only after this loop is over:
    // a workspace whose switch went off after the registration, or a thread that left the tree that named it.
    const fell = (): void => {
      if (toldThePerson) return;
      toldThePerson = true;
      ctx.record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify: NOTIFY_ME, text: notifyLine(threadId, result, "tail") });
    };
    for (const target of targets) {
      // A thread reads its child's line as a message and acts on it, so it gets the report whole; the person reads
      // it as a row beside every other, so theirs stays one line.
      const text = notifyLine(threadId, result, target === NOTIFY_ME ? "tail" : "whole");
      ctx.record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify: target, text });
      if (target === NOTIFY_ME) continue;
      // A turn whose agent replied over background work sends a line per reply, each kept apart.
      const line: Owed = { id: `${s.turnId}:${s.turnLive?.told ?? 0}:${target}`, from: threadId, notify: target, text, ...named };
      void ctx.store.put(NOTIFY_OWED, line.id, line).catch((e: unknown) => console.warn(`the line of thread ${threadId.slice(0, 8)} into thread ${target.slice(0, 8)} was not kept: ${e instanceof Error ? e.message : String(e)}`));
      deliver({ ...line, fell });
    }
  };
  /** Every line a host that stopped had not seen taken, sent again once this one has read its rows. */
  const deliverOwed = async (): Promise<void> => {
    for (const raw of await ctx.store.list(NOTIFY_OWED)) {
      const line = readOwed(raw);
      if (line !== undefined && !sending.has(line.id)) deliver(line);
    }
  };
  /** Settles a running row whose process the runtime ended or lost before the harness's own session.end: to the reply
   * it held, whose line already went, or failed with `cutLine` as the parent's word when it never replied, interrupted
   * where a stop settled it. A reply held
   * over background work whose line went, with nothing waking the agent since, is the turn's last word: no line. The
   * session.end carries `reason` either way. The one rule for both roads, the runtime's end() and the restart load. */
  const settleCut = (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; snapshot?: string }, reason: string, cutLine: (endedAt: number) => string, stopped = false): void => {
    const reply = s.turnLive?.reply;
    delete s.snapshot;
    const endedAt = Date.now();
    s.view.status = reply ?? (stopped ? "interrupted" : "failed");
    if (reply === undefined) writeLines(s.view, turnLines({ status: s.view.status }, reason));
    ctx.portRootsMoved(s.view.workspaceId);
    s.view.endedAt = endedAt;
    if (s.view.status === "failed") ctx.endSnoozeFor(s.view);
    // A prompt the turn was stopped on goes with it, on this road as on the harness's own exit: nothing can answer
    // one whose process is gone, and a settled row still carrying it would read as waiting on a person forever.
    delete s.view.asking;
    if (s.view.threadId !== undefined) leadAsks.delete(s.view.threadId);
    const cut: TurnResult = { status: stopped ? "interrupted" : "failed", error: cutLine(endedAt) };
    if (reply === undefined && s.turnLive?.toldLast !== true && s.notify !== undefined) notifyEnd(s, s.notify, tellAs(s), cut);
    const sessionId = s.view.claudeSessionId ?? s.view.id;
    // A stop the process never heard is still the turn's reply, so every client reads the turn stopped, not failed.
    if (reply === undefined && stopped) ctx.record({ type: "session.done", workspaceId: s.view.workspaceId, sessionId, turnId: s.turnId, threadId: s.view.threadId, result: cut });
    ctx.record({ type: "session.end", workspaceId: s.view.workspaceId, sessionId, turnId: s.turnId, threadId: s.view.threadId, exitCode: null, sawResult: reply !== undefined || stopped, reason });
  };
  /** A folder on this computer git holds no repo in: it keeps no checkpoint and no rewind moves its files. */
  const notARepo = (r: WorkspaceRecord): boolean => runsInFolder(r.kind) && ctx.projectHeld(r.project).git === undefined;
  /** What a rewind to a turn needs, kept once the turn is over: the checkout's tree through the workspace's own
   * daemon, and the harness's anchor. A checkout the daemon takes none of (not a repo, a daemon too old, a machine
   * gone) leaves the anchor alone; the turn itself is as it ended either way. */
  /** The checkpoint a thread's last turn is still writing, which a drop of its refs waits for. */
  const checkpointsLanding = new Map<string, Promise<void>>();
  const keepCheckpoint = async (entry: LiveWorkspace, turn: { sessionId: string; threadId: string; turnId: string; anchor?: string; kept?: string }): Promise<void> => {
    let ref: string | undefined;
    if (!notARepo(entry.record)) {
      try {
        // Scoped by the record's id, so the refs of two folders of one repo never share a prefix.
        const taken = await ctx.withDaemon(entry, ask => ask({ op: "git.checkpoint", cwd: ctx.checkoutOf(entry.record), thread: turn.threadId, turn: turn.turnId, scope: entry.record.id }));
        if (typeof taken["ref"] === "string") ref = taken["ref"];
      } catch (e) {
        console.warn(noCheckpointLogLine(turn.threadId, entry.record.id, e instanceof Error ? e.message : String(e)));
      }
    }
    if (ref === undefined && turn.anchor === undefined && turn.kept === undefined) return;
    ctx.record({ type: "session.checkpoint", workspaceId: entry.record.id, sessionId: turn.sessionId, turnId: turn.turnId, threadId: turn.threadId, ...(ref !== undefined ? { ref } : {}), ...(turn.anchor !== undefined ? { anchor: turn.anchor } : {}), ...(turn.kept !== undefined ? { kept: turn.kept } : {}) });
  };
  /** Recorded once the harness took the line, so the row sits where the turn could first see it. */
  /** The handle a start already taken answers with: the turn's own while it runs, and while it does not, one whose
   * finish is the end the transcript holds. Nothing where the session index no longer holds the session. */
  const takenTurn = async (workspaceId: string, taken: Taken): Promise<SessionHandle | undefined> => {
    const held = sessions.get(taken.sessionId);
    if (held === undefined) return undefined;
    if (held.handle !== undefined && held.turnId === taken.turnId) return { ...held.handle, outcome: taken.outcome };
    const events = await ctx.openTranscript(workspaceId);
    const done = events.find(e => e.type === "session.done" && e.turnId === taken.turnId);
    const end = events.find(e => e.type === "session.end" && e.turnId === taken.turnId);
    const result: TurnResult = done?.type === "session.done" ? done.result : { status: "failed", error: end?.type === "session.end" && end.reason !== undefined ? end.reason : RESTARTED_REASON };
    return { id: taken.sessionId, workspaceId, turnId: taken.turnId, outcome: taken.outcome, finished: Promise.resolve(result), view: () => sessions.get(taken.sessionId)?.view ?? held.view, interrupt: async () => {} };
  };

  const recordSteer = (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, handleId: string, o: { prompt: string; requestId?: string; via?: "slate"; startedBy?: SessionOrigin }, caller: Caller | undefined, steerId: string): void => {
    if (s.turnLive !== undefined) {
      const by = scopeOf(caller);
      const road = roadOf(caller);
      s.turnLive.steered = { ...s.turnLive.steered, [steerId]: { prompt: o.prompt, startedBy: o.startedBy ?? "person", ...(by !== undefined ? { by } : {}), ...(road !== undefined ? { road } : {}) } };
      void ctx.persistSessions(s.view.workspaceId);
    }
    ctx.record({
      type: "session.steer",
      workspaceId: s.view.workspaceId,
      sessionId: s.view.claudeSessionId ?? handleId,
      turnId: s.turnId,
      ...(s.view.threadId !== undefined ? { threadId: s.view.threadId } : {}),
      prompt: o.prompt,
      ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
      ...(o.via !== undefined ? { via: o.via } : {}),
      // Read off the row the turn writes its open prompt on: a message that joined a turn stopped on one waits for
      // the person as the turn does, and the caller says so rather than going quiet until the prompt is answered.
      ...(s.view.asking !== undefined ? { waiting: true } : {}),
    });
  };

  /** How long a launch waits on its folder's snapshot before the turn runs without one. */
  const snapshotMs = opts.turnSnapshotMs ?? 3_000;

  /** The folder a turn works in as one commit, through the daemon's own snapshot, which leaves the checkout's index
   * and refs as they were. Nothing where the workspace is the person's own folder, the machine has no daemon to ask,
   * the folder is no checkout, or the daemon does not answer inside the deadline: the turn runs regardless and its
   * reply lists no changes. */
  const snapshotOf = async (entry: LiveWorkspace, cwd: string): Promise<string | undefined> => {
    if (notARepo(entry.record) || ctx.reachOf(entry) !== "reachable") return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">(resolve => (timer = setTimeout(() => resolve("late"), snapshotMs)));
    const taken = ctx.withDaemon(entry, async ask => String((await ask({ op: "git.snapshot", cwd }))["commit"])).catch((e: unknown) => {
      if (!(e instanceof DaemonRefusal && e.code === "not-a-git-repo")) console.warn(`no snapshot of ${cwd} on ${entry.record.name}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    try {
      const commit = await Promise.race([taken, late]);
      if (commit === "late") console.warn(`no snapshot of ${cwd} on ${entry.record.name} inside ${snapshotMs}ms; the turn runs without one and its reply lists no changes`);
      return commit === "late" ? undefined : commit;
    } finally {
      clearTimeout(timer);
    }
  };

  /** The top of the checkout a folder sits in, as git names it, off the repo's worktree list; undefined for a folder
   * git holds no repo in, or one the daemon did not answer for. */
  const topOf = (entry: LiveWorkspace, cwd: string): Promise<string | undefined> =>
    ctx.withDaemon(entry, ask => ask({ op: "git.worktrees", cwd })).then(
      reply => {
        const read = GitWorktreesReply.safeParse(reply);
        return read.success ? worktreeOf(cwd, read.data.worktrees.filter(w => !w.prunable).map(w => w.path)) : undefined;
      },
      () => undefined,
    );

  /** Whether another thread's turn in this workspace ran in the same checkout at any point between the two times: in
   * this folder, or in another folder of the same checkout, since a turn's snapshots and range cover the whole tree. */
  const sharedFolder = async (entry: LiveWorkspace, threadId: string, cwd: string, top: () => Promise<string | undefined>, from: number, to: number): Promise<boolean> => {
    const beside = [...sessions.values()].flatMap(({ view }) =>
      view.workspaceId === entry.record.id && view.threadId !== threadId && view.cwd !== undefined && (view.startedAt ?? 0) <= to && (view.endedAt ?? to) >= from ? [view.cwd] : [],
    );
    if (beside.includes(cwd)) return true;
    const mine = beside.length === 0 ? undefined : await top();
    if (mine === undefined) return false;
    for (const folder of new Set(beside)) if ((await topOf(entry, folder)) === mine) return true;
    return false;
  };

  /** Which of the paths an agent's tool calls named are files of the checkout at top, as git names them from it;
   * undefined where the top cannot be read, so the card stays the folder's. */
  const ownIn = async (cwd: string, top: () => Promise<string | undefined>, wrote: ReadonlySet<string>): Promise<Set<string> | undefined> => {
    if (wrote.size === 0) return new Set();
    const root = await top();
    return root === undefined ? undefined : new Set([...wrote].flatMap(path => repoPathOf(path, cwd, root) ?? []));
  };

  /** What a turn changed in its folder: a snapshot now, the range from the commit its launch took, and the files in it
   * recorded under the turn. wrote holds the paths the agent's own tool calls named, where its harness reports them:
   * in a folder another thread worked in meanwhile, those are the turn's files and the rest are the others'. True once
   * the range is read, whether or not it held anything; a turn that changed nothing records nothing. */
  const readTurnChanges = async (entry: LiveWorkspace, turn: { sessionId: string; turnId: string; threadId: string; cwd: string; from: string; startedAt: number; wrote?: ReadonlySet<string> }): Promise<boolean> => {
    const { sessionId, turnId, threadId, cwd, from, startedAt, wrote } = turn;
    const workspaceId = entry.record.id;
    const to = await snapshotOf(entry, cwd);
    if (to === undefined) return false;
    const range = await ctx.withDaemon(entry, ask => ask({ op: "git.turn", cwd, from, to })).catch((e: unknown) => {
      console.warn(`what ${turnId} changed in ${cwd} was not read: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    const read = GitDiffReply.safeParse(range);
    if (!read.success) return false;
    const files = read.data.files.map(({ path, kind, additions, deletions }) => ({ path, kind, additions, deletions }));
    const moved = read.data.moved;
    // A turn that only moved HEAD (a checkout or pull with no edit of its own) still records its line.
    if (files.length === 0 && moved.length === 0) return true;
    let topRead: Promise<string | undefined> | undefined;
    const top = (): Promise<string | undefined> => (topRead ??= topOf(entry, cwd));
    const shared = await sharedFolder(entry, threadId, cwd, top, startedAt, Date.now());
    const own = shared && wrote !== undefined ? await ownIn(cwd, top, wrote) : undefined;
    const split = own === undefined ? { files } : { files: files.filter(f => own.has(f.path)), others: files.filter(f => !own.has(f.path)) };
    ctx.record({ type: "session.changes", workspaceId, sessionId, turnId, threadId, from, to, ...split, moved, ...(shared ? { shared: true as const } : {}) });
    return true;
  };

  /** What a turn is once its harness session exists: the one road from the harness's events to the transcript, the
   * index, the bus and the row, whether the session was launched here or re-opened on the machine after a restart.
   * A re-opened turn's run is read from its first byte, so what the transcript already holds for this turn is
   * counted first and read past in silence: a delta is recorded once however many hosts read the run it came from. */
  /** The computer a workspace runs on as the usage records key it: its place, this computer, or the provider it forks at. */
  const usageComputerOf = (r: WorkspaceRecord): string => r.place ?? (isLocalWorkspace(r) ? HERE_PLACE_ID : (r.provider ?? r.kind));

  /** What the vault holds for an agent's sign-in, where the machine's own login does not stand in front of it. */
  const vaultedFor = (agent: string, loginStands?: boolean): Vaulted => {
    const secrets = CATALOG_AGENTS.some(a => a.id === agent) ? secretsOf(opts.vault?.() ?? {}, agent as ThreadAgent, loginStands) : {};
    return secrets.oauthToken !== undefined ? "token" : secrets.apiKey !== undefined ? "key" : undefined;
  };

  /** The sign-in a machine runs a harness with, as the usage records key and name it. */
  const usageAccountOf = (entry: LiveWorkspace, harness: string, named?: { id: string; label?: string }) =>
    accountOf({
      agent: harness,
      agentName: harnessCatalog(harness)?.label ?? harness,
      ...(named !== undefined ? { named } : {}),
      vaulted: vaultedFor(harness, ctx.moduleOf(entry.record.kind).loginStands(entry, harness)),
      computer: { id: usageComputerOf(entry.record), name: ctx.computerOf(entry) },
    });

  /** Whether a turn of this agent on this workspace reads its account's banked resets in full: an agent whose plan
   * banks none never does, and a ledger that cannot be read leaves the turn on the count alone. */
  const limitDetailsDue = async (entry: LiveWorkspace, harness: string): Promise<boolean> => {
    if (PLAN_RESETS[harness as ThreadAgent] === undefined) return false;
    try {
      const limits = await ctx.ledger.limits();
      const vaulted = vaultedFor(harness, ctx.moduleOf(entry.record.kind).loginStands(entry, harness));
      const { key } = accountOnComputer({ agent: harness, agentName: harnessCatalog(harness)?.label ?? harness, computer: { id: usageComputerOf(entry.record), name: ctx.computerOf(entry) }, limits, vaulted });
      return resetDetailsDue(limits.find(l => l.key === key), clock.now());
    } catch {
      return false;
    }
  };
  return {
    threadRuns, launchingOn, runningOn, latestOn, keptAgents, reapKept, endKept, hostWrites, writeSession, takeKept,
    holdKept, threadOfToken, treeUnder, drivesThread, settlesThread, leadAsks, capHeld, capHold, capLend, capFull, capWait, capStop, capStopping, capLeft, stoppedBehind, stopUnder, notifyOn, notifyReach, tellAs,
    notifyEnd, deliverOwed, sendBack, settleCut, notARepo, checkpointsLanding, keepCheckpoint, takenTurn, recordSteer, snapshotOf,
    readTurnChanges, usageComputerOf, vaultedFor, usageAccountOf, limitDetailsDue,
  };
}
