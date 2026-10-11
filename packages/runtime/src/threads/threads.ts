// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { CATALOG_AGENTS, type ThreadAgent } from "@wsp/catalog";
import { MachineUnreachableError, MachineUnreached, isPlaceAbsent } from "@wsp/engine";
import {
  AGENT_KEEP_MS, AGENT_WARM_MS, AGENTS_KEPT, AGENTS_WARM, type PermissionAsk, type SessionRenameWrite, type SessionView, type TurnResult,
  type Caller, SessionOrigin, ThreadScope, WorkspaceOrigin, GitDiffReply, GitWorktreesReply, repoPathOf, worktreeOf, foldThreads, threadWord, threadsFollowed, scopeOf,
  type ThreadWaitingOn, isLocalWorkspace, NO_SUCH_TURN, NOTIFY_ME, notifyLine, runsInFolder, DEVICE_OPS, sendRefusal,
  workspaceState, HERE_PLACE_ID, runningOn as runningOnPlace, type ThreadCapWait, roadOf, unreadLine, turnLines,
  type Attachment, AttachmentRecord, attachmentKey, attachmentRecord,
} from "@wsp/protocol";
import { harnessCatalog } from "../harness-catalog.js";
import { PLAN_RESETS, secretsOf } from "../adapters.js";
import { accountOf, accountOnComputer, resetDetailsDue, type Vaulted } from "../usage.js";
import { DeadlineError, type WorkspaceRecord, type LiveWorkspace, type SessionHandle } from "../types/wiring.js";
import { isDaemonUnanswered } from "../daemon-channel.js";
import { LaunchUnanswered } from "../machine-exec.js";
import {
  RESTARTED_REASON, NOTIFY_OWED, OWED_RETRY_MS, OWED_RETRY_MAX_MS, OWED_FOR_MS, readRoad, readScope, noCheckpointLogLine, type Taken, type TurnAsked, type TurnLive, type KeptProcess, type KeptLaunch, launchesAs,
  stampSessionFile, sameSessionFile, DaemonRefusal, type LiveSession, type SessionEntry, HELD_STARTS, type HeldStartRecord, writeLines, ATTACHMENTS,
} from "../types/internal.js";
import type { CapHeld, RuntimeContext, ThreadsArea } from "../context.js";

/** The row the person is told where a line falls, kept with the line so a host that restarts tells it too. */
type PersonRow = { workspaceId: string; sessionId: string; turnId: string; text: string };
/** A line into one thread, as the store keeps it until that thread takes it: a child's finished line, or a message
 * steered into the thread's turn that its agent never read, which goes as whoever opened it. `since` is the wall time
 * it became owed and `requestId` the one request every try of it goes under, on any host; `tries` is how many of those
 * failed on a computer that did not answer and `next` when the next may go, so a restart keeps the spacing. */
type Owed = { id: string; from: string; notify: string; text: string; by?: ThreadScope; road?: WorkspaceOrigin; startedBy?: SessionOrigin; toPerson?: PersonRow; since?: number; requestId?: string; tries?: number; next?: number; images?: OwedImages };
/** The images a steered message carried, which its send-back reads from the host's keep under the steer's request. */
type OwedImages = { under: string; records: AttachmentRecord[] };
const readOwedImages = (raw: unknown): OwedImages | undefined => {
  const r = raw as Partial<Record<keyof OwedImages, unknown>> | undefined;
  const records = AttachmentRecord.array().safeParse(r?.records);
  return typeof r?.under === "string" && records.success && records.data.length > 0 ? { under: r.under, records: records.data } : undefined;
};
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
  const images = readOwedImages(r.images);
  return {
    id: r.id, from: r.from, notify: r.notify, text: r.text,
    ...(by !== undefined ? { by } : {}), ...(road !== undefined ? { road } : {}),
    ...(startedBy.success ? { startedBy: startedBy.data } : {}), ...(toPerson !== undefined ? { toPerson } : {}),
    ...(typeof r.since === "number" ? { since: r.since } : {}), ...(typeof r.requestId === "string" ? { requestId: r.requestId } : {}),
    ...(typeof r.tries === "number" ? { tries: r.tries } : {}), ...(typeof r.next === "number" ? { next: r.next } : {}),
    ...(images !== undefined ? { images } : {}),
  };
};

/** Whether a start or a launch failed on the way to its thread's computer, which did not answer, rather than was
 * refused: read off the class or the kind stamped where the error was born, never its words, so a refusal thrown as a
 * plain Error goes to the person at once and is never tried again. */
export const computerSilent = (e: unknown): boolean =>
  e instanceof MachineUnreached || e instanceof MachineUnreachableError || e instanceof DeadlineError || e instanceof LaunchUnanswered || isPlaceAbsent(e) || isDaemonUnanswered(e);

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
   * person resumed it in a terminal). Any other kept process of the thread is ended here, and the turn boots cold. One
   * launched ahead of the send runs at what it was launched with and nothing else, so it is matched on the send's whole
   * launch, every pick the send left to the defaults included, both ways. */
  const takeKept = (threadId: string, launch: KeptLaunch | undefined, session: string | undefined, whole?: KeptLaunch): KeptProcess | undefined => {
    const kept = keptAgents.get(threadId);
    if (kept === undefined) return undefined;
    const asked = kept.warm === undefined ? launch : whole;
    const matches = asked !== undefined && launchesAs(kept.launch, asked) && (kept.warm === undefined || launchesAs(asked, kept.launch));
    if (!matches || kept.session !== session || !sameSessionFile(kept.agent.sessionFile, kept.file)) {
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
    keep(threadId, { ...o, ...(file !== undefined ? { file } : {}), usedAt: clock.now(), cancel: () => {} }, AGENT_KEEP_MS);
    return true;
  };

  /** A process launched ahead of a new thread's first send, kept under the thread id its launch was minted for: it
   * counts against the same cap, ends after AGENT_WARM_MS unless the composer asks for it again, and the one asked for
   * longest ago ends once more than AGENTS_WARM stand. */
  const holdWarm = (threadId: string, o: Omit<KeptProcess, "file" | "usedAt" | "cancel">): void => {
    if (ctx.state.closing) {
      endKept(threadId, { ...o, usedAt: 0, cancel: () => {} });
      return;
    }
    keep(threadId, { ...o, usedAt: clock.now(), cancel: () => {} }, AGENT_WARM_MS);
    for (;;) {
      const standing = [...keptAgents].filter(([, kept]) => kept.warm?.claimed === false);
      if (standing.length <= AGENTS_WARM) return;
      reapKept(standing.reduce((a, b) => (b[1].usedAt < a[1].usedAt ? b : a))[0]);
    }
  };
  /** The standing process launched ahead of a send on this workspace for this agent that no send took yet. */
  const warmOn = (workspaceId: string, harness: string): [string, KeptProcess] | undefined =>
    [...keptAgents].find(([, kept]) => kept.workspaceId === workspaceId && kept.warm?.harness === harness && !kept.warm.claimed);
  /** The composer asked again for the process standing: its window starts over. */
  const rewarm = (threadId: string): void => {
    const kept = keptAgents.get(threadId);
    if (kept === undefined) return;
    kept.cancel();
    kept.usedAt = clock.now();
    arm(threadId, kept, AGENT_WARM_MS);
  };
  /** A send opening a thread takes the thread id of the process standing for its workspace and agent, so its launch
   * runs as that thread's from here: taken once, by one send. */
  const claimWarm = (workspaceId: string, harness: string): string | undefined => {
    const found = warmOn(workspaceId, harness);
    if (found === undefined) return undefined;
    found[1].warm!.claimed = true;
    return found[0];
  };

  const arm = (threadId: string, kept: KeptProcess, ms: number): void => {
    kept.cancel = clock.schedule(() => {
      if (keptAgents.get(threadId) === kept) reapKept(threadId);
    }, ms, { unref: true });
  };
  const keep = (threadId: string, kept: KeptProcess, ms: number): void => {
    arm(threadId, kept, ms);
    keptAgents.set(threadId, kept);
    // A process that went on its own takes its token with it; nothing is left to close.
    void kept.agent.exited.then(() => {
      if (keptAgents.get(threadId) !== kept) return;
      keptAgents.delete(threadId);
      kept.cancel();
      if (kept.scopeDeviceId !== undefined) void deviceDoor.revoke(kept.scopeDeviceId).catch(() => {});
    });
    while (keptAgents.size > AGENTS_KEPT) {
      const [oldest] = [...keptAgents].reduce((a, b) => (b[1].usedAt < a[1].usedAt ? b : a));
      reapKept(oldest);
    }
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
  /** Each thread that has a restart, by the restart: off the records, and off a held start's entry before its record is
   * written, so a restart the threads at once hold is linked while it waits. */
  const restarts = (): Map<string, string> => {
    const found = new Map<string, string>();
    for (const s of sessions.values()) if (s.replaces !== undefined && s.view.threadId !== undefined) found.set(s.replaces, s.view.threadId);
    for (const [id, record] of threadRecords) if (record.replaces !== undefined) found.set(record.replaces, id);
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
  const heldLines = new Map<string, Owed[]>();
  /** The lines this host is carrying, by id, each as it stands, which the boot's pass over the store leaves to the road
   * already on them. */
  const sending = new Map<string, Owed>();
  /** A line leaves the store once a turn of its thread took it, or once it fell to the person. */
  const owedTaken = (line: Owed): void => {
    sending.delete(line.id);
    void ctx.store.delete(NOTIFY_OWED, line.id).catch((e: unknown) => console.warn(`the line of thread ${line.from.slice(0, 8)} into thread ${line.notify.slice(0, 8)} stays owed: ${e instanceof Error ? e.message : String(e)}`));
  };
  /** The line as it stands, written to the store, so a next host goes on from it. */
  const keepOwed = (line: Owed): Promise<void> =>
    ctx.store.put(NOTIFY_OWED, line.id, line).catch((e: unknown) => console.warn(`the line of thread ${line.from.slice(0, 8)} into thread ${line.notify.slice(0, 8)} was not kept: ${e instanceof Error ? e.message : String(e)}`));
  /** A child's end is told the person once however many of its lines fall: the row leaves every other line of that
   * end once told, here and in the store, so neither this host nor a next one tells it again. Once the boot's pass over
   * the store has run, every line there is one this host carries, a held one included, so the others are in `sending`. */
  const tellPerson = (line: Owed): void => {
    const row = line.toPerson;
    if (row === undefined) return;
    ctx.record({ type: "session.notify", ...row, threadId: line.from, notify: NOTIFY_ME });
    for (const other of sending.values()) {
      if (other.id === line.id || other.toPerson?.turnId !== row.turnId || other.toPerson.text !== row.text) continue;
      delete other.toPerson;
      void keepOwed(other);
    }
  };
  /** Who the lines off a row are delivered as: the thread that registered its targets and the road it registered
   * them from, read off the row that holds both so the two never drift apart. */
  const tellAs = (s: { notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin }): { by?: ThreadScope; road?: WorkspaceOrigin } => ({
    ...(s.notifyBy !== undefined ? { by: s.notifyBy } : {}),
    ...(s.notifyRoad !== undefined ? { road: s.notifyRoad } : {}),
  });
  /** Whether a turn of the thread took the request: a steer under it joined a turn, which then sends back what its
   * agent never read, or a turn started under it and its agent holds the prompt, which one that announced itself
   * before it was handed the prompt (Codex) says by announcing again. */
  const tookRequest = (workspaceId: string, requestId: string): boolean => {
    const taken = ctx.transcriptIndex.get(workspaceId)?.taken.get(requestId);
    if (taken === undefined) return false;
    return taken.outcome === "steered" || ![...sessions.values()].some(s => s.turnId === taken.turnId && s.asked?.awaitsPrompt === true);
  };
  /** A turn carrying a line the host keeps is that line's try until its agent holds the line: how it ends is the
   * line's to tell, so the thread's own targets hear nothing of it. */
  const lineTry = (s: { view: SessionView; turnId: string; asked?: TurnAsked }): boolean => {
    const requestId = s.asked?.owed === true ? s.asked.requestId : undefined;
    if (requestId === undefined) return false;
    return ctx.transcriptIndex.get(s.view.workspaceId)?.taken.get(requestId)?.turnId !== s.turnId || s.asked?.awaitsPrompt === true;
  };
  /** The tries out whose request a turn may take, by request: each settles its line as taken once that turn's agent
   * holds the prompt. */
  const promptWaits = new Map<string, () => void>();
  const promptHeld = (requestId: string): void => promptWaits.get(requestId)?.();
  /** The tries out on a computer that answered nothing since the restart, by turn: a person's stop of one settles its
   * line, since nothing reaches the turn itself. */
  const darkTries = new Map<string, () => void>();
  const tryStopped = (turnId: string): void => darkTries.get(turnId)?.();
  /** The end the host records for a turn's row, read as the turn's result: what settles a row whose agent cannot be
   * reached, a turn a restart left on a computer that did not answer its re-open, or one a stop ended while its
   * computer was away, whose agent's own end never comes. */
  const rowEnded = (s: SessionEntry): Promise<TurnResult> =>
    new Promise(resolve => {
      const off = bus.on("session.end", e => {
        if (e.type !== "session.end" || e.turnId !== s.turnId) return;
        off();
        resolve({ status: s.view.status === "interrupted" ? "interrupted" : "failed", ...(e.reason !== undefined ? { error: e.reason } : {}) });
      });
    });
  /** The running turn of the thread a try of the request is still out on: its launch carries it, or it kept the
   * message steered under it before a write whose answer never came. */
  const carrying = (threadId: string, requestId: string): SessionEntry | undefined =>
    [...sessions.values()].find(s => s.view.threadId === threadId && s.view.status === "running" && (s.asked?.requestId === requestId || Object.values(s.turnLive?.steered ?? {}).some(m => m.requestId === requestId)));
  /** What failed a turn's stream, off its row while that turn still holds it. */
  const failureOf = (h: Pick<SessionHandle, "id" | "turnId">): unknown => {
    const row = sessions.get(h.id);
    return row?.turnId === h.turnId ? row.turnLive?.failure : undefined;
  };
  /** The line into the parent thread as a send would go: steered into its running turn, or queued behind it, which
   * is what a parent still in its own reply tail gets, since the send road waits for that process rather than
   * refusing. It goes under the thread that named the target, so the switch on that thread's workspace and the
   * tree rule are read at delivery and not at registration alone; a line a person registered goes as the person's,
   * which is what every row written before the scope rode beside the targets carries.
   *
   * The line stays owed until a turn of the parent takes it: a steer under its request, or a launch whose agent
   * announced itself. Every try goes under the one request id, written on the line before the first, so a start the
   * parent already took answers that turn and starts nothing, and a try still out on a running turn is waited out
   * before another goes: a lost answer is never a second line. A start or a launch the parent's computer did not
   * answer goes again on the clock, spaced out as they keep failing, for an hour of wall time from when the line
   * became owed; at the hour the try still out is stopped and the person is told the report is there. So are they at
   * once where the door or the computer refuses, where the parent has no session to resume, and where they stopped
   * the turn carrying the line. A line held for the parent's wake gets a try at the wake, past its hour or not: the
   * hour bounds tries while the computer answers. The child's end must not fail on any of it. */
  const deliver = (line: Owed, o: { woke?: true } = {}): void => {
    const { from, notify, text, by, road } = line;
    // Written before the first try, so the next host sends the same request and can tell whether a turn took it.
    const sent: Owed = { ...line, since: line.since ?? clock.now(), requestId: line.requestId ?? randomUUID() };
    sending.set(line.id, sent);
    const requestId = sent.requestId!;
    const deadline = sent.since! + OWED_FOR_MS;
    const kept = line.requestId === undefined || line.since === undefined ? keepOwed(sent) : Promise.resolve();
    const carried = (): boolean => !ctx.state.closing && sending.get(line.id) === sent;
    const fell = (): void => {
      owedTaken(sent);
      tellPerson(sent);
    };
    /** A turn of the parent took the line. A child's finished line is its whole report, so a lead that took it has
     * read the child. */
    const taken = (): void => {
      if (sending.get(line.id) !== sent) return;
      owedTaken(sent);
      if (line.startedBy === undefined) void ctx.mark([from], { readAt: clock.now() }, undefined).catch((e: unknown) => console.warn(`thread ${from.slice(0, 8)} was not marked read: ${e instanceof Error ? e.message : String(e)}`));
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
      heldLines.set(parent.workspaceId, [...(heldLines.get(parent.workspaceId) ?? []), sent]);
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
    const gaveUp = (said: string): void => {
      console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)} within ${OWED_FOR_MS / 60_000} minutes: ${said}`);
      fell();
    };
    const tryAgain = (said: string): void => {
      const left = deadline - clock.now();
      if (left <= 0) return gaveUp(said);
      sent.tries = (sent.tries ?? 0) + 1;
      const wait = Math.min(OWED_RETRY_MS * 2 ** (sent.tries - 1), OWED_RETRY_MAX_MS, left);
      sent.next = clock.now() + wait;
      void keepOwed(sent);
      console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)} yet, and goes again in ${wait / 1000} s: ${said}`);
      clock.schedule(() => {
        if (carried()) deliver(sent);
      }, wait, { unref: true });
    };
    /** Settles a try a turn of the parent carries, launched here or re-opened from an earlier host: taken once the
     * parent's agent announced itself under the request, stopped at the line's hour, and otherwise read off how the
     * turn ended before its agent announced itself, which never handed the agent the line. A stop is the person's and
     * the line goes no further; a nap that cut it waits for the wake; a computer that did not answer goes again on the
     * clock; anything else is a refusal and falls to the person. */
    const settleTry = async (handle: Pick<SessionHandle, "id" | "turnId"> & { finished?: Promise<TurnResult> }, dark = false): Promise<void> => {
      promptWaits.set(requestId, () => {
        if (carried()) taken();
      });
      if (tookRequest(parent.workspaceId, requestId)) taken();
      try {
        let atHour = false;
        // A try on a computer that answered nothing since the restart is out of reach: nothing stops it, so at the
        // hour, at once past it, and at the person's stop the line is settled without it, and the turn is left as it
        // stands. One whose computer answers is stopped at the hour by the stop road, and runs on past it, since a try
        // already out is the one try a wake past the hour gets.
        let cut: (r: TurnResult) => void = () => {};
        const cutShort = new Promise<TurnResult>(resolve => (cut = resolve));
        if (dark) darkTries.set(handle.turnId, () => cut({ status: "interrupted" }));
        const left = deadline - clock.now();
        const stop =
          left > 0 || dark
            ? clock.schedule(() => {
                if (!carried() || tookRequest(parent.workspaceId, requestId)) return;
                atHour = true;
                if (dark) return cut({ status: "failed", error: `nothing answered for the turn carrying it since the host restarted` });
                void ctx.stopTry(handle.id).catch((e: unknown) => console.warn(`the try of the line of thread ${from.slice(0, 8)} into thread ${notify.slice(0, 8)} was not stopped: ${e instanceof Error ? e.message : String(e)}`));
              }, Math.max(left, 0), { unref: true })
            : undefined;
        const row = sessions.get(handle.id);
        const ends = [cutShort, ...(handle.finished !== undefined ? [handle.finished] : []), ...(row?.turnId === handle.turnId ? [rowEnded(row)] : [])];
        const ended = await Promise.race(ends).catch((e: unknown): TurnResult => ({ status: "failed", error: e instanceof Error ? e.message : String(e) }));
        stop?.();
        if (!carried()) return;
        if (tookRequest(parent.workspaceId, requestId)) return taken();
        const said = ended.error ?? `the turn ended ${ended.status} before its agent started`;
        if (atHour) return gaveUp(said);
        if (ended.status === "interrupted") {
          console.warn(`thread ${from.slice(0, 8)} ended, but the turn carrying its line into thread ${notify.slice(0, 8)} was stopped`);
          return fell();
        }
        if (holdForWake()) return;
        if (computerSilent(failureOf(handle))) return tryAgain(said);
        console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)}: ${said}`);
        fell();
      } finally {
        promptWaits.delete(requestId);
        darkTries.delete(handle.turnId);
      }
    };
    void (async () => {
      await kept;
      if (line.requestId !== undefined) {
        // A next host reads the try only once its re-open of the parent's turns answered or failed: a row with no
        // handle before then says nothing about its computer.
        await ctx.bootWork.get(parent.workspaceId);
        if (!carried()) return;
        if (tookRequest(parent.workspaceId, requestId)) return taken();
        const out = carrying(notify, requestId);
        if (out !== undefined) {
          const steered = out.asked?.requestId !== requestId;
          if (!steered && out.handle !== undefined) return settleTry(out.handle);
          if (!steered && out.launch === undefined) return settleTry({ id: out.view.id, turnId: out.turnId }, true);
          const over = await (out.handle?.finished.then(() => true, () => true) ?? out.launch?.then(() => false, () => false) ?? new Promise<boolean>(resolve => clock.schedule(() => resolve(false), OWED_RETRY_MS, { unref: true })));
          if (!carried()) return;
          if (steered && over) {
            // A turn that kept the message before its write sends it back at its end if its agent never read it, where
            // that agent tells what it never read. Any other cannot say: the person is told, rather than the thread twice.
            if (out.handle?.tellsUnread?.() === true) return taken();
            console.warn(`thread ${from.slice(0, 8)} ended, and nothing says whether thread ${notify.slice(0, 8)} read its line`);
            return fell();
          }
          return deliver(sent);
        }
      }
      // A line that has failed before keeps its spacing and its hour across a restart, until the wake it waited for.
      if ((sent.tries ?? 0) > 0 && o.woke !== true) {
        if (clock.now() >= deadline) return gaveUp("its last try failed");
        if (sent.next !== undefined && sent.next > clock.now()) {
          clock.schedule(() => {
            if (carried()) deliver(sent);
          }, sent.next - clock.now(), { unref: true });
          return;
        }
      }
      try {
        const attachments = line.images === undefined ? [] : await keptImages(parent.workspaceId, notify, line.images);
        const handle = await ctx.sessionsApi.start(parent.workspaceId, { prompt: text, ...(attachments.length > 0 ? { attachments } : {}), harness: parent.harness, thread: notify, startedBy: line.startedBy ?? "agent", requestId, owed: true, ...(deadline > clock.now() ? { asksUntilStopped: true as const } : {}), ...(line.startedBy === undefined ? { wakesLead: true as const } : {}) }, asWho);
        if (handle.outcome === "steered") return taken();
        await settleTry(handle);
      } catch (e: unknown) {
        // A line queued behind the parent's turn meets the nap that ended that turn: it waits for the wake as well.
        if (holdForWake()) return;
        const said = e instanceof Error ? e.message : String(e);
        if (computerSilent(e)) return tryAgain(said);
        console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)}: ${said}`);
        fell();
      }
    })().catch((e: unknown) => {
      // Nothing above throws by design; one that does leaves the line in the store for the next host.
      sending.delete(line.id);
      console.warn(`the line of thread ${from.slice(0, 8)} into thread ${notify.slice(0, 8)} was not sent: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  /** A sent-back message's images, read from what the host kept of its steer; one gone with its row goes without. */
  const keptImages = async (workspaceId: string, threadId: string, images: OwedImages): Promise<Attachment[]> => {
    await ctx.keptWrites.get(workspaceId);
    const read = await Promise.all(images.records.map(async (record, index) => {
      const key = attachmentKey(threadId, images.under, index);
      const bytes = key === undefined ? undefined : await ctx.store.getBlob(ATTACHMENTS, key);
      return bytes === undefined ? [] : [{ mediaType: record.mediaType, bytes: bytes.toString("base64"), ...(record.name !== undefined ? { name: record.name } : {}) }];
    }));
    return read.flat();
  };
  /** The steers whose write has not answered yet, by the id the harness is handed each under: the start road owns the
   * message until it answers. A turn that ends meanwhile with it unread leaves it here, with whether a stop ended
   * that turn, for that road to settle, so the message never goes both as the turn's unread and as the next turn. */
  const steersOut = new Map<string, { ended?: { s: { view: SessionView; turnId: string; turnLive?: TurnLive }; stopped: boolean } }>();
  /** The messages steered into a turn that its agent never read, once the turn is over: each goes into the thread
   * again as its next message, in the words the row kept when it was steered, kept in the store as a child's line is,
   * under the caller that steered it and opened by whoever opened it, so the doors read it as a fresh steer and a nap
   * or a host restart keeps it. A turn the person stopped tells the person instead. An id the row does not hold is a
   * line on the run's input this host never wrote, and goes nowhere. */
  const sendBack = (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, ids: readonly string[], stopped: boolean): void => {
    const threadId = s.view.threadId;
    if (threadId === undefined) return;
    for (const id of ids) {
      const out = steersOut.get(id);
      if (out !== undefined) {
        out.ended = { s, stopped };
        continue;
      }
      const steered = s.turnLive?.steered?.[id];
      if (steered === undefined) continue;
      const { prompt, requestId: steeredUnder, attachments, ...as } = steered;
      const toPerson: PersonRow = { workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, text: unreadLine(prompt) };
      if (stopped) {
        ctx.record({ type: "session.notify", ...toPerson, threadId, notify: NOTIFY_ME });
        continue;
      }
      const images = steeredUnder !== undefined && attachments !== undefined ? { images: { under: steeredUnder, records: attachments } } : {};
      deliver({ id: `${s.turnId}:unread:${id}`, from: threadId, notify: threadId, text: prompt, ...as, toPerson, ...images });
    }
  };
  // A wake or a rebuild (of a gone or zombie machine) puts the workspace back to running: the held lines go now.
  for (const type of ["workspace.woken", "workspace.upgraded"] as const) {
    bus.on(type, e => {
      if (e.type !== type) return;
      const lines = heldLines.get(e.workspaceId) ?? [];
      heldLines.delete(e.workspaceId);
      for (const l of lines) deliver(l, { woke: true });
    });
  }
  /** The one line an ending turn sends where its thread's start said: into a thread, or nowhere further for me, whom
   * the recorded event reaches. Recorded before the turn's session.done, since a follower ends there; the person's
   * own row for a line that falls is the exception, since that answer comes after the start it made. A target whose
   * thread has gone by now cannot be told, and its report must not go with it: the person is told instead, once,
   * however many targets fell away, and each line keeps the person's row so a next host can do the same. */
  const notifyEnd = (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, notify: readonly string[], named: { by?: ThreadScope; road?: WorkspaceOrigin }, result: TurnResult): void => {
    const threadId = s.view.threadId;
    if (threadId === undefined) return;
    const reachable = notify.filter(target => target === NOTIFY_ME || tellable(latestOn(target)));
    const targets = reachable.length === notify.length ? notify : [...new Set([...reachable, NOTIFY_ME])];
    const toPerson: PersonRow = { workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, text: notifyLine(threadId, result, "tail") };
    for (const target of targets) {
      // A thread reads its child's line as a message and acts on it, so it gets the report whole; the person reads
      // it as a row beside every other, so theirs stays one line.
      const text = notifyLine(threadId, result, target === NOTIFY_ME ? "tail" : "whole");
      ctx.record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify: target, text });
      if (target === NOTIFY_ME) continue;
      // A turn whose agent replied over background work sends a line per reply, each kept apart.
      deliver({ id: `${s.turnId}:${s.turnLive?.told ?? 0}:${target}`, from: threadId, notify: target, text, ...named, ...(targets.includes(NOTIFY_ME) ? {} : { toPerson }) });
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
   * where a stop settled it. A reply held over background work whose line went said another line follows, so its cut
   * sends one too. The session.end carries `reason` either way. The one rule for both roads, the runtime's end() and
   * the restart load. */
  const settleCut = (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; snapshot?: string; asked?: TurnAsked }, reason: string, cutLine: (endedAt: number) => string, stopped = false, unreached = false): void => {
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
    const cut: TurnResult = { status: stopped ? "interrupted" : "failed", error: cutLine(endedAt), ...(stopped && unreached ? { unreached: true as const } : {}) };
    if (reply === undefined && s.notify !== undefined && !lineTry(s)) notifyEnd(s, s.notify, tellAs(s), cut);
    const sessionId = s.view.claudeSessionId ?? s.view.id;
    // A stop the process never heard is still the turn's reply, so every client reads the turn stopped, not failed.
    if (reply === undefined && stopped) ctx.record({ type: "session.done", workspaceId: s.view.workspaceId, sessionId, turnId: s.turnId, threadId: s.view.threadId, result: cut });
    ctx.record({ type: "session.end", workspaceId: s.view.workspaceId, sessionId, turnId: s.turnId, threadId: s.view.threadId, exitCode: null, sawResult: reply !== undefined || stopped, reason, ...(s.asked?.awaitsPrompt === true ? { promptless: true as const } : {}) });
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
    let based = false;
    if (!notARepo(entry.record)) {
      try {
        // Scoped by the record's id, so the refs of two folders of one repo never share a prefix.
        const taken = await ctx.withDaemon(entry, ask => ask({ op: "git.checkpoint", cwd: ctx.checkoutOf(entry.record), thread: turn.threadId, turn: turn.turnId, scope: entry.record.id }));
        if (typeof taken["ref"] === "string") ref = taken["ref"];
        based = taken["based"] === true;
      } catch (e) {
        console.warn(noCheckpointLogLine(turn.threadId, entry.record.id, e instanceof Error ? e.message : String(e)));
      }
    }
    if (ref === undefined && turn.anchor === undefined && turn.kept === undefined) return;
    ctx.record({ type: "session.checkpoint", workspaceId: entry.record.id, sessionId: turn.sessionId, turnId: turn.turnId, threadId: turn.threadId, ...(ref !== undefined ? { ref } : {}), ...(ref !== undefined && based ? { based: true as const } : {}), ...(turn.anchor !== undefined ? { anchor: turn.anchor } : {}), ...(turn.kept !== undefined ? { kept: turn.kept } : {}) });
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

  /** The message on the turn's row under the id the harness is handed it by, written to the store: what its end sends
   * back if the agent never took it up, past a host restart too. */
  const keepOnTurn = (s: { view: SessionView; turnLive?: TurnLive }, o: { prompt: string; requestId?: string; startedBy?: SessionOrigin; attachments?: readonly Attachment[] }, caller: Caller | undefined, steerId: string): Promise<void> => {
    if (s.turnLive === undefined) return Promise.resolve();
    const by = scopeOf(caller);
    const road = roadOf(caller);
    const attachments = (o.attachments ?? []).map(attachmentRecord);
    s.turnLive.steered = { ...s.turnLive.steered, [steerId]: { prompt: o.prompt, startedBy: o.startedBy ?? "person", ...(by !== undefined ? { by } : {}), ...(road !== undefined ? { road } : {}), ...(o.requestId !== undefined ? { requestId: o.requestId } : {}), ...(attachments.length > 0 ? { attachments } : {}) } };
    return ctx.persistSessions(s.view.workspaceId);
  };
  /** The message kept on the turn before its write goes, the start road owning it until the write answers. */
  const keepSteer = (s: { view: SessionView; turnLive?: TurnLive }, o: { prompt: string; requestId?: string; startedBy?: SessionOrigin; attachments?: readonly Attachment[] }, caller: Caller | undefined, steerId: string): Promise<void> => {
    steersOut.set(steerId, {});
    return keepOnTurn(s, o, caller, steerId);
  };
  /** A message kept before a write that did not land in the turn: its caller starts it as the next turn instead. */
  const dropSteer = (s: { view: SessionView; turnLive?: TurnLive }, steerId: string): void => {
    if (s.turnLive?.steered?.[steerId] === undefined) return;
    const { [steerId]: _dropped, ...rest } = s.turnLive.steered;
    s.turnLive.steered = rest;
    void ctx.persistSessions(s.view.workspaceId);
  };
  /** A steer whose write threw on an agent that tells no unread messages: nothing will say whether it landed, so the
   * turn lets the message go and its caller hears the write failed. */
  const steerLost = (s: { view: SessionView; turnLive?: TurnLive }, steerId: string): void => {
    steersOut.delete(steerId);
    dropSteer(s, steerId);
  };
  /** Settles a steer whose write answered, `landed` unless it answered that the turn was not running: true where the
   * message is the turn's now, false where the start road queues it as the thread's next turn. One the turn's end
   * found unread while the write was out goes as that next turn, or to the person where a stop ended the turn, and
   * never by both roads. */
  const steerAnswered = (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, handleId: string, o: { prompt: string; requestId?: string; via?: "slate"; startedBy?: SessionOrigin; attachments?: readonly Attachment[] }, caller: Caller | undefined, steerId: string, landed: boolean): boolean => {
    const ended = steersOut.get(steerId)?.ended;
    steersOut.delete(steerId);
    if (ended === undefined && landed) {
      recordSteer(s, handleId, o, caller, steerId);
      return true;
    }
    if (ended?.stopped === true) {
      sendBack(ended.s, [steerId], true);
      return true;
    }
    dropSteer(s, steerId);
    return false;
  };
  const recordSteer = (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, handleId: string, o: { prompt: string; requestId?: string; via?: "slate"; startedBy?: SessionOrigin; attachments?: readonly Attachment[] }, caller: Caller | undefined, steerId: string): void => {
    if (s.turnLive?.steered?.[steerId] === undefined) void keepOnTurn(s, o, caller, steerId);
    const records = (o.attachments ?? []).map(attachmentRecord);
    // Kept before the row is written, so a client drawing the row asks for bytes the host already holds.
    if (s.view.threadId !== undefined && records.length > 0) void ctx.keepSentImages(s.view.workspaceId, s.view.threadId, o.requestId, o.attachments!);
    ctx.record({
      type: "session.steer",
      workspaceId: s.view.workspaceId,
      sessionId: s.view.claudeSessionId ?? handleId,
      turnId: s.turnId,
      ...(s.view.threadId !== undefined ? { threadId: s.view.threadId } : {}),
      prompt: o.prompt,
      ...(records.length > 0 ? { attachments: records } : {}),
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
  const vaultedFor = (agent: string, loginStands?: boolean, vault: Readonly<Record<string, string>> = opts.vault?.() ?? {}): Vaulted => {
    const secrets = CATALOG_AGENTS.some(a => a.id === agent) ? secretsOf(vault, agent as ThreadAgent, loginStands) : {};
    return secrets.oauthToken !== undefined ? "token" : secrets.apiKey !== undefined ? "key" : undefined;
  };

  /** The sign-in a machine runs a harness with, as the usage records key and name it. */
  const usageAccountOf = (entry: LiveWorkspace, harness: string, named?: { id: string; label?: string }) =>
    accountOf({
      agent: harness,
      agentName: harnessCatalog(harness)?.label ?? harness,
      ...(named !== undefined ? { named } : {}),
      vaulted: vaultedFor(harness, ctx.moduleOf(entry.record.kind).loginStands(entry, harness), ctx.vaultOn(entry)),
      computer: { id: usageComputerOf(entry.record), name: ctx.computerOf(entry) },
    });

  /** Whether a turn of this agent on this workspace reads its account's banked resets in full: an agent whose plan
   * banks none never does, and a ledger that cannot be read leaves the turn on the count alone. */
  const limitDetailsDue = async (entry: LiveWorkspace, harness: string): Promise<boolean> => {
    if (PLAN_RESETS[harness as ThreadAgent] === undefined) return false;
    try {
      const limits = await ctx.ledger.limits();
      const vaulted = vaultedFor(harness, ctx.moduleOf(entry.record.kind).loginStands(entry, harness), ctx.vaultOn(entry));
      const { key } = accountOnComputer({ agent: harness, agentName: harnessCatalog(harness)?.label ?? harness, computer: { id: usageComputerOf(entry.record), name: ctx.computerOf(entry) }, limits, vaulted });
      return resetDetailsDue(limits.find(l => l.key === key), clock.now());
    } catch {
      return false;
    }
  };
  return {
    threadRuns, launchingOn, runningOn, latestOn, keptAgents, reapKept, endKept, hostWrites, writeSession, takeKept,
    holdKept, holdWarm, warmOn, rewarm, claimWarm, threadOfToken, treeUnder, restarts, drivesThread, settlesThread, leadAsks, capHeld, capHold, capLend, capFull, capWait, capStop, capStopping, capLeft, stoppedBehind, stopUnder, notifyOn, notifyReach, tellAs,
    notifyEnd, deliverOwed, sendBack, settleCut, notARepo, checkpointsLanding, keepCheckpoint, takenTurn, keepSteer, steerAnswered, steerLost, recordSteer, lineTry, promptHeld, tryStopped, snapshotOf,
    readTurnChanges, usageComputerOf, vaultedFor, usageAccountOf, limitDetailsDue,
  };
}
