// SPDX-License-Identifier: AGPL-3.0-only
// Every thread transcript this window holds, kept outside React so a view that unmounts loses nothing and one that
// mounts draws what is held in its first frame. A thread is held from its head (its facts and newest events, as
// sessions.head answers them) and grows by pages of sessions.history: the newest window when it is opened, older
// ones as the reader scrolls up. Each session event off the bus folds into the thread it names where that thread is
// held, and one at or under the transcript position the thread is held through is one it already has. Positions run
// per workspace with no hole, so an event past the next one says this window missed some: every thread held there
// goes stale and reads its head and newest window again when it is next shown. What is held is bounded: past
// BUDGET_BYTES of event text or BUDGET_THREADS threads held past their head, the thread shown longest ago is cut back
// to its head; the thread on screen and a running one whose tile is in view are never cut.
import { HEAD_BYTES, HISTORY_PAGE_EVENTS, isSessionEvent, type HistoryPage, type SessionEvent, type ThreadFacts, type ThreadHead } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../../protocol/client";
import type { SessionFold } from "../../adapt/session";

export const BUDGET_BYTES = 24 * 1024 * 1024;
/** Said as the settings say an op the connection lacks; a view that meets it reads the whole history instead. */
const CANNOT_PAGE = "This wsp cannot read a thread a page at a time from here.";
export const BUDGET_THREADS = 16;
/** Heads read for tiles at once: the host reads a transcript with synchronous sqlite calls on its one event loop, so a
 * click's read waits behind every head already sent, and holding them to two keeps that wait short. */
export const WARM_AT_ONCE = 2;
/** What one event weighs beyond its text: its ids, stamps and keys, as the wire carries them. */
const EVENT_OVERHEAD = 200;

export interface HeldThread {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly facts: ThreadFacts | null;
  /** Oldest first, a contiguous run of the thread's newest events. */
  readonly events: ReadonlyArray<SessionEvent>;
  /** When this window took each event, which places a row the wire left unstamped. */
  readonly arrivals: ReadonlyArray<string>;
  /** The workspace transcript's position every event of the thread up to is held. */
  readonly through: number;
  /** How many events the host holds of the thread. */
  readonly total: number;
  /** The newest window is held whole, past the head's cut results: a view opening it asks nothing. */
  readonly whole: boolean;
  /** Nothing older is left on the host. */
  readonly complete: boolean;
  /** The host's caps dropped older events of the thread, so even a complete hold is not all it ever said. */
  readonly trimmed: boolean;
  readonly bytes: number;
  /** Events may be missing. After a gap the rows held still stand and the newest are read again over them; after a
   * rewind, or a socket the host could not replay to, none can be trusted and the thread is read from its head. */
  readonly stale: false | "gap" | "reset";
  /** After a gap, the workspace's newest position seen before it: rows held up to there are whole, past it may not be. */
  readonly hole?: number;
  /** Moves when the events change other than by a live event landing at the end: a head, a page, a reload. */
  readonly epoch: number;
}

/** A fold over a thread's events as some reader last derived them, kept with the thread so a view mounted again
 * folds only what came after. */
export interface HeldFold {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly arrivals: ReadonlyArray<string>;
  readonly fold: SessionFold;
}

export const eventBytes = (e: SessionEvent): number => {
  switch (e.type) {
    case "session.delta":
      return EVENT_OVERHEAD + e.text.length;
    case "session.start":
    case "session.steer":
      return EVENT_OVERHEAD + (e.prompt?.length ?? 0);
    case "session.done":
      return EVENT_OVERHEAD + (e.result.text?.length ?? 0);
    case "session.plan":
      return EVENT_OVERHEAD + (e.text?.length ?? 0);
    default:
      return EVENT_OVERHEAD;
  }
};

const sumBytes = (events: ReadonlyArray<SessionEvent>): number => events.reduce((n, e) => n + eventBytes(e), 0);

/**
 * Whether a row already held belongs after one arriving. Between two lines of one turn the runtime's own counter
 * decides, since that is the place it gave them and a restart writes the same line again under a new clock; two rows
 * the transcript placed are told by that place; everything else is placed by the stamp the runtime wrote, and a row
 * from before the stamp existed has no order of its own and keeps the place it arrived in.
 */
export function comesAfter(held: SessionEvent, arriving: SessionEvent): boolean {
  if (held.type === "session.delta" && arriving.type === "session.delta" && held.turnId === arriving.turnId && held.line !== undefined && arriving.line !== undefined) {
    return held.line > arriving.line;
  }
  if (held.pos !== undefined && arriving.pos !== undefined) return held.pos > arriving.pos;
  if (held.at === undefined || arriving.at === undefined) return false;
  return held.at > arriving.at;
}

/** Where an arriving reading of what the agent holds replaces the one its turn already has: each of the agent's calls
 * passes one, and only the latest is read. -1 for any other event, and for a turn's first reading. */
export function heldReading(events: ReadonlyArray<SessionEvent>, e: SessionEvent): number {
  return e.type === "session.context" ? events.findLastIndex(held => held.type === "session.context" && held.turnId === e.turnId) : -1;
}

/** Where a live event goes among the ones held: after every row that does not come after it. */
export function liveIndex(events: ReadonlyArray<SessionEvent>, e: SessionEvent): number {
  let index = events.length;
  while (index > 0 && comesAfter(events[index - 1]!, e)) index--;
  return index;
}

interface Rows {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly arrivals: ReadonlyArray<string>;
}

/**
 * A page of the thread laid over the rows held. The page is the host's word for every position it spans, so a cut
 * result it carries whole replaces the cut one, and a held row inside its span it does not carry is one the host no
 * longer holds. Rows older than the page stay; rows newer than the transcript was when the page was read are live
 * ones it was read too early to carry, and stay after it. A row the transcript never recorded keeps its place after
 * the row it followed.
 */
export function overlay(held: Rows, page: ReadonlyArray<SessionEvent>, readAt: number, at: string, hole = Infinity): Rows {
  const lo = page.find(e => e.pos !== undefined)?.pos;
  // Rows older than the page join it only where the two share a row held from before any hole: positions run per
  // workspace, so with none shared the thread may have events between them that neither holds.
  const joins = lo !== undefined && held.events.some(e => e.pos !== undefined && e.pos >= lo && e.pos <= readAt && e.pos <= hole);
  const older: number[] = [];
  const newer: number[] = [];
  let anchor = 0;
  held.events.forEach((e, i) => {
    if (e.pos === undefined) {
      if (lo === undefined || anchor >= lo) newer.push(i);
      else if (joins) older.push(i);
      return;
    }
    anchor = e.pos;
    if (lo !== undefined && e.pos < lo) {
      if (joins) older.push(i);
    } else if (e.pos > readAt) newer.push(i);
  });
  const rows = [...older, ...newer];
  const split = older.length;
  return {
    events: [...rows.slice(0, split).map(i => held.events[i]!), ...page, ...rows.slice(split).map(i => held.events[i]!)],
    arrivals: [...rows.slice(0, split).map(i => held.arrivals[i] ?? at), ...page.map(() => at), ...rows.slice(split).map(i => held.arrivals[i] ?? at)],
  };
}

const firstPos = (events: ReadonlyArray<SessionEvent>): number | undefined => events.find(e => e.pos !== undefined)?.pos;
const recorded = (events: ReadonlyArray<SessionEvent>): number => events.reduce((n, e) => n + (e.pos === undefined ? 0 : 1), 0);

/** The newest rows that fit a head's bytes: what an eviction leaves of a thread. */
function headOf(rows: Rows): Rows {
  let room = HEAD_BYTES;
  let from = rows.events.length;
  while (from > 0) {
    const cost = eventBytes(rows.events[from - 1]!);
    if (cost > room && from < rows.events.length) break;
    room -= cost;
    from--;
  }
  return { events: rows.events.slice(from), arrivals: rows.arrivals.slice(from) };
}

const runningIn = (held: HeldThread): boolean => {
  if (held.facts !== null) return held.facts.status === "running";
  const last = held.events.findLast(e => e.type === "session.start" || e.type === "session.end");
  return last?.type === "session.start";
};

const now = () => new Date().toISOString();

export function createTranscripts(clock: () => number = Date.now) {
  let api: Api | null = null;
  const held = new Map<string, HeldThread>();
  const folds = new Map<string, HeldFold>();
  const listeners = new Map<string, Set<() => void>>();
  const shown = new Map<string, number>();
  const shownAt = new Map<string, number>();
  const visible = new Set<string>();
  /** Events of a thread whose first read is on its way, kept for the read to place against. */
  const waiting = new Map<string, SessionEvent[]>();
  const loading = new Map<string, Promise<void>>();
  /** Tiles in view waiting for their head, oldest first, and the heads being read for tiles now. */
  let toWarm = new Set<string>();
  let warming = new Set<string>();
  /** Reads for a thread being opened; while one is out no tile's head is asked for. */
  let opening = 0;
  const paging = new Map<string, Promise<void>>();
  /** The newest position seen per workspace, off the bus or a reply. */
  const seen = new Map<string, number>();
  /** Events the bus carried that a held thread already had; a view folding the bus itself skips them too. */
  let dropped = new WeakSet<SessionEvent>();
  /** When this window took each live event, so a view folding the same event places it at the same moment. */
  let arrived = new WeakMap<SessionEvent, string>();
  let generation = 0;
  let epochs = 0;

  const tell = (threadId: string): void => {
    for (const fn of [...(listeners.get(threadId) ?? [])]) fn();
  };
  const put = (next: HeldThread): void => {
    held.set(next.threadId, next);
    tell(next.threadId);
  };
  const saw = (workspaceId: string, pos: number): void => {
    if (pos > (seen.get(workspaceId) ?? 0)) seen.set(workspaceId, pos);
  };

  /** Cuts the threads shown longest ago back to their heads until what is held fits. */
  const fit = (): void => {
    const pinned = (t: HeldThread): boolean => (shown.get(t.threadId) ?? 0) > 0 || (visible.has(t.threadId) && runningIn(t));
    const heavy = (t: HeldThread): boolean => t.whole || t.bytes > HEAD_BYTES;
    let bytes = 0;
    let full = 0;
    for (const t of held.values()) {
      bytes += t.bytes;
      if (heavy(t)) full += 1;
    }
    const order = [...held.values()].filter(t => heavy(t) && !pinned(t)).sort((a, b) => (shownAt.get(a.threadId) ?? 0) - (shownAt.get(b.threadId) ?? 0));
    for (const t of order) {
      if (bytes <= BUDGET_BYTES && full <= BUDGET_THREADS) break;
      const head = headOf(t);
      const cut = sumBytes(head.events);
      bytes -= t.bytes - cut;
      full -= 1;
      folds.delete(t.threadId);
      put({ ...t, ...head, bytes: cut, whole: false, complete: false, epoch: ++epochs });
    }
  };

  /** Lays a reply over what is held of the thread, or starts holding it, with the live events its read missed. */
  const land = (workspaceId: string, threadId: string, reply: { events: ReadonlyArray<SessionEvent>; pos: number; total: number; trimmed?: true; facts?: ThreadFacts }, whole: boolean): void => {
    saw(workspaceId, reply.pos);
    const at = now();
    const was = held.get(threadId);
    const base: Rows = was ?? { events: [], arrivals: [] };
    let rows = overlay(base, reply.events, reply.pos, at, was?.stale === "gap" ? was.hole : undefined);
    let through = Math.max(was?.through ?? 0, reply.pos);
    for (const e of waiting.get(threadId) ?? []) {
      if (e.pos !== undefined && e.pos <= through) continue;
      const reading = heldReading(rows.events, e);
      if (reading >= 0) {
        rows = { events: rows.events.with(reading, e), arrivals: rows.arrivals.with(reading, at) };
        continue;
      }
      const index = liveIndex(rows.events, e);
      rows = { events: [...rows.events.slice(0, index), e, ...rows.events.slice(index)], arrivals: [...rows.arrivals.slice(0, index), at, ...rows.arrivals.slice(index)] };
      if (e.pos !== undefined) through = e.pos;
    }
    waiting.delete(threadId);
    // A thread read without being shown (a hover) counts as shown when it lands, so the budget does not undo the read.
    if (!shownAt.has(threadId)) shownAt.set(threadId, clock());
    const total = Math.max(reply.total, recorded(rows.events));
    put({
      workspaceId,
      threadId,
      facts: reply.facts ?? was?.facts ?? null,
      ...rows,
      through,
      total,
      whole: whole || (was?.whole === true && was.stale === false),
      complete: recorded(rows.events) >= total,
      trimmed: reply.trimmed === true || was?.trimmed === true,
      bytes: sumBytes(rows.events),
      stale: false,
      epoch: ++epochs,
    });
    fit();
  };

  const headFor = async (threadId: string): Promise<ThreadHead> => {
    if (api?.sessionHead === undefined) throw new Error(CANNOT_PAGE);
    return api.sessionHead(threadId);
  };
  const windowFor = async (workspaceId: string, threadId: string, before?: number): Promise<HistoryPage> => {
    if (api?.sessionPage === undefined) throw new Error(CANNOT_PAGE);
    return api.sessionPage(workspaceId, threadId, { limit: HISTORY_PAGE_EVENTS, ...(before === undefined ? {} : { before }) });
  };

  /** Reads what the thread needs to be drawn whole and fresh: its head where nothing is held or what is held is stale,
   * and its newest window where that is not held whole. One read per thread at a time. */
  const open = (workspaceId: string, threadId: string): Promise<void> => {
    const going = loading.get(threadId);
    if (going !== undefined) return going.then(() => open(workspaceId, threadId));
    const was = held.get(threadId);
    if (was !== undefined && was.whole && !was.stale) return Promise.resolve();
    const asked = generation;
    opening += 1;
    const read = (async () => {
      const reset = was === undefined || was.stale === "reset";
      if (reset) waiting.set(threadId, []);
      // The head paints the thread the moment it lands; the window behind it fills in what the head cut.
      const page = windowFor(was?.workspaceId ?? workspaceId, threadId);
      page.catch(() => {});
      if (reset) {
        const head = await headFor(threadId);
        if (asked !== generation) return;
        if (was !== undefined) {
          folds.delete(threadId);
          held.delete(threadId);
        }
        land(head.facts.workspaceId, threadId, head, false);
      }
      // After a gap the rows held stand: the window is laid over them first, judged against the hole, and the head
      // brings only the facts, since its rows would vouch for a join across the hole.
      const facts = was?.stale === "gap" ? headFor(threadId) : null;
      facts?.catch(() => {});
      const newest = await page;
      const now = held.get(threadId);
      if (asked !== generation) return;
      land(now?.workspaceId ?? was?.workspaceId ?? workspaceId, threadId, newest, true);
      if (facts !== null) {
        const head = await facts;
        const landed = held.get(threadId);
        if (asked === generation && landed !== undefined) put({ ...landed, facts: head.facts });
      }
    })().finally(() => {
      if (loading.get(threadId) === read) loading.delete(threadId);
      waiting.delete(threadId);
      if (asked === generation) opening -= 1;
      pump();
    });
    loading.set(threadId, read);
    return read;
  };

  /** Starts the heads waiting for tiles in view, WARM_AT_ONCE at a time and none while a thread is being opened. */
  const pump = (): void => {
    for (const threadId of toWarm) {
      if (warming.size >= WARM_AT_ONCE || opening > 0) return;
      toWarm.delete(threadId);
      if (held.has(threadId) || loading.has(threadId) || api?.sessionHead === undefined) continue;
      const asked = generation;
      const mine = warming;
      mine.add(threadId);
      waiting.set(threadId, []);
      const read = headFor(threadId)
        .then(head => {
          if (asked !== generation || held.has(threadId)) return;
          land(head.facts.workspaceId, threadId, head, false);
        })
        .catch(() => {})
        .finally(() => {
          if (loading.get(threadId) === read) loading.delete(threadId);
          waiting.delete(threadId);
          mine.delete(threadId);
          if (asked === generation) pump();
        });
      loading.set(threadId, read);
    }
  };

  /** A head alone, for a tile in view: what a click on it draws in its first frame. */
  const warm = (threadId: string): void => {
    if (held.has(threadId) || loading.has(threadId) || api?.sessionHead === undefined) return;
    toWarm.add(threadId);
    pump();
  };

  /** The page before the oldest event held; one at a time per thread, dropped if the thread was read again meanwhile. */
  const older = (threadId: string): Promise<void> => {
    const going = paging.get(threadId);
    if (going !== undefined) return going;
    const was = held.get(threadId);
    const oldest = was === undefined ? undefined : firstPos(was.events);
    if (was === undefined || was.complete || oldest === undefined || loading.has(threadId)) return Promise.resolve();
    const asked = generation;
    const read = windowFor(was.workspaceId, threadId, oldest)
      .then(page => {
        const now = held.get(threadId);
        if (asked !== generation || now === undefined || now.stale === "reset" || firstPos(now.events) !== oldest) return;
        const at = new Date().toISOString();
        const taken = page.events.filter(e => e.pos !== undefined && e.pos < oldest);
        const events = [...taken, ...now.events];
        const total = Math.max(page.total, recorded(events));
        put({
          ...now,
          events,
          arrivals: [...taken.map(() => at), ...now.arrivals],
          total,
          complete: taken.length === 0 || recorded(events) >= total,
          trimmed: now.trimmed || page.trimmed === true,
          bytes: now.bytes + sumBytes(taken),
          epoch: ++epochs,
        });
        fit();
      })
      .finally(() => {
        if (paging.get(threadId) === read) paging.delete(threadId);
      });
    paging.set(threadId, read);
    return read;
  };

  /** Every thread held in the workspace, or every one, may be missing events. */
  const stale = (how: "gap" | "reset", workspaceId?: string, hole?: number): void => {
    for (const t of [...held.values()]) {
      if (workspaceId !== undefined && t.workspaceId !== workspaceId) continue;
      if (t.stale === "reset") continue;
      const since = hole === undefined ? t.hole : Math.min(t.hole ?? hole, hole);
      put({ ...t, stale: how, ...(how === "gap" && since !== undefined ? { hole: since } : {}) });
    }
  };

  /** One event off the bus, before any view reads it. */
  const apply = (e: ProtocolEvent): void => {
    if (e.type === "thread.head") {
      const t = held.get(e.threadId);
      if (t !== undefined) put({ ...t, facts: e.facts });
      return;
    }
    if (e.type === "thread.rewound") {
      const t = held.get(e.threadId);
      if (t !== undefined) put({ ...t, stale: "reset" });
      return;
    }
    if (!isSessionEvent(e)) return;
    if (e.pos !== undefined) {
      const last = seen.get(e.workspaceId);
      saw(e.workspaceId, e.pos);
      if (last !== undefined && e.pos > last + 1) stale("gap", e.workspaceId, last);
    }
    if (e.threadId === undefined) return;
    const pending = waiting.get(e.threadId);
    if (pending !== undefined) {
      pending.push(e);
      return;
    }
    const t = held.get(e.threadId);
    if (t === undefined) return;
    if (e.pos !== undefined && e.pos <= t.through) {
      dropped.add(e);
      return;
    }
    const at = now();
    const reading = heldReading(t.events, e);
    if (reading >= 0) {
      arrived.set(e, at);
      put({ ...t, events: t.events.with(reading, e), arrivals: t.arrivals.with(reading, at) });
      return;
    }
    const index = liveIndex(t.events, e);
    arrived.set(e, at);
    put({
      ...t,
      events: [...t.events.slice(0, index), e, ...t.events.slice(index)],
      arrivals: [...t.arrivals.slice(0, index), at, ...t.arrivals.slice(index)],
      through: e.pos ?? t.through,
      total: e.pos === undefined ? t.total : t.total + 1,
      bytes: t.bytes + eventBytes(e),
    });
    // A thread running off screen grows by its own events alone; it is cut as a read would be.
    let bytes = 0;
    for (const one of held.values()) bytes += one.bytes;
    if (bytes > BUDGET_BYTES) fit();
  };

  return {
    /** A new socket, or none: everything held belonged to the last one. */
    bind(next: Api | null): void {
      api = next;
      generation += 1;
      const threads = [...held.keys()];
      held.clear();
      folds.clear();
      waiting.clear();
      loading.clear();
      toWarm = new Set();
      warming = new Set();
      opening = 0;
      paging.clear();
      seen.clear();
      dropped = new WeakSet();
      arrived = new WeakMap();
      for (const id of threads) tell(id);
    },
    /** Whether the host answers heads and pages; a view of a host that does not reads the whole history. */
    serves(): boolean {
      return api?.sessionHead !== undefined && api.sessionPage !== undefined;
    },
    get: (threadId: string): HeldThread | undefined => held.get(threadId),
    listen(threadId: string, fn: () => void): () => void {
      let fns = listeners.get(threadId);
      if (fns === undefined) listeners.set(threadId, (fns = new Set()));
      fns.add(fn);
      return () => {
        fns.delete(fn);
        if (fns.size === 0) listeners.delete(threadId);
      };
    },
    apply,
    /** The socket's own gap: the host could not replay what it missed. */
    gap(): void {
      seen.clear();
      stale("reset");
    },
    open,
    older,
    warm,
    /** The thread is on screen until the returned function runs: never cut, and the last shown when it leaves. */
    show(threadId: string): () => void {
      shown.set(threadId, (shown.get(threadId) ?? 0) + 1);
      shownAt.set(threadId, clock());
      return () => {
        const left = (shown.get(threadId) ?? 1) - 1;
        if (left > 0) shown.set(threadId, left);
        else shown.delete(threadId);
        shownAt.set(threadId, clock());
        fit();
      };
    },
    /** Which tiles are in view: a running thread among them is never cut. */
    see(threadId: string, inView: boolean): void {
      if (inView) visible.add(threadId);
      else {
        visible.delete(threadId);
        toWarm.delete(threadId);
      }
    },
    /** Whether the bus carried this event to a thread that already had it. */
    dropped: (e: SessionEvent): boolean => dropped.has(e),
    arrivedAt: (e: SessionEvent): string | undefined => arrived.get(e),
    fold: (threadId: string): HeldFold | undefined => folds.get(threadId),
    keepFold(threadId: string, fold: HeldFold): void {
      if (held.has(threadId)) folds.set(threadId, fold);
    },
    /** What is held, for the budget's test and the bench. */
    weight(): { bytes: number; full: number; threads: number } {
      let bytes = 0;
      let full = 0;
      for (const t of held.values()) {
        bytes += t.bytes;
        if (t.whole || t.bytes > HEAD_BYTES) full += 1;
      }
      return { bytes, full, threads: held.size };
    },
  };
}

export type Transcripts = ReturnType<typeof createTranscripts>;

/** The one this window holds. */
export const transcripts = createTranscripts();
