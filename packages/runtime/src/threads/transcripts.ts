// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import type { Machine } from "@wsp/engine";
import { type SessionEvent, type Attachment, type RanPicks, isLocalWorkspace, attachmentKey, isImage, modelPicks, recordedPicks, threadRan } from "@wsp/protocol";
import { assertTokenShape, daemonTokenFor, daemonTokenPathOf, rotateDaemonToken } from "../daemon-token.js";
import type { EventSize, TranscriptRows } from "../sqlite-transcripts.js";
import { eventBytes, numbered, pickNewest, readThread, type TranscriptReader } from "../transcript-reader.js";
import type { LiveWorkspace } from "../types/wiring.js";
import {
  TRANSCRIPTS, TRANSCRIPT_HEADS, TRANSCRIPT_INDEX, ATTACHMENTS, ATTACHMENT_KEYS, SESSIONS, DAEMON_TOKEN_MISS_TTL_MS,
  TRANSCRIPT_CAP, TRANSCRIPT_BYTES, TOOL_RESULT_KEPT, TRANSCRIPTS_HELD, PENDING_FLUSH_BYTES, type TranscriptIndex,
  transcriptUnreadLine, emptyIndex, forgetChild, foldEvent, indexOf, indexBytes, indexRead, SESSION_INDEX_CAP,
  TRANSCRIPT_FLUSH_MS, type TranscriptRecord, type ThreadRecord, type SessionIndexRecord, type KeptImages,
} from "../types/internal.js";
import type { RuntimeContext, TranscriptsArea } from "../context.js";

export function transcriptsArea(ctx: RuntimeContext): TranscriptsArea {
  const {
    opts, store, bus, clock, live, threadRecords, sessions, indexFlushes, transcripts, rows, unreadIndexes,
    pendingEvents, pendingBytes, transcriptIndex, indexFor, transcriptBytes, sizeOf,
  } = ctx;
  const keptWrites = new Map<string, Promise<void>>();
  /** One chain per workspace, so two sends writing at once cannot lose each other's keys. */
  const onKept = (workspaceId: string, step: (held: KeptImages) => Promise<KeptImages | undefined>): Promise<void> => {
    const next = (keptWrites.get(workspaceId) ?? Promise.resolve())
      .then(async () => {
        const held = ((await store.get(ATTACHMENT_KEYS, workspaceId)) as KeptImages | undefined) ?? { threads: {} };
        // A step that wrote its own document answers nothing here.
        const now = await step(held);
        if (now === undefined) return;
        if (Object.keys(now.threads).length === 0) await store.delete(ATTACHMENT_KEYS, workspaceId);
        else await store.put(ATTACHMENT_KEYS, workspaceId, now);
      })
      .catch((e: unknown) => console.warn(`the images ${workspaceId}'s messages carried were not kept as asked: ${e instanceof Error ? e.message : String(e)}`));
    keptWrites.set(workspaceId, next);
    return next;
  };
  /** Keeps the images a send carried, for every client to draw again; a send no client could name keeps none. */
  const keepSentImages = (workspaceId: string, threadId: string, requestId: string | undefined, attachments: readonly Attachment[]): Promise<void> => {
    const kept = attachments.flatMap((a, index) => {
      const key = attachmentKey(threadId, requestId, index);
      return isImage(a.mediaType) && key !== undefined ? [{ key, mediaType: a.mediaType, bytes: a.bytes }] : [];
    });
    if (kept.length === 0) return Promise.resolve();
    return onKept(workspaceId, async held => {
      const had = (held.threads[threadId] ?? []).filter(h => !kept.some(k => k.key === h.key));
      // The entry before the bytes: a crash between the two leaves an entry whose blob is missing, which reads as not
      // found and goes with its thread, never a blob no document names and nothing can sweep.
      await store.put(ATTACHMENT_KEYS, workspaceId, { threads: { ...held.threads, [threadId]: [...had, ...kept.map(({ key, mediaType }) => ({ key, mediaType }))] } });
      for (const k of kept) await store.putBlob(ATTACHMENTS, k.key, Buffer.from(k.bytes, "base64"));
      return undefined;
    });
  };
  /** Takes these images away, a send's records having left the transcript, so no row can ask for them again. */
  const dropKeptKeys = (workspaceId: string, keys: readonly string[]): Promise<void> =>
    onKept(workspaceId, async held => {
      const going = new Set(keys);
      if (!Object.values(held.threads).some(list => list.some(k => going.has(k.key)))) return undefined;
      for (const key of going) await store.deleteBlob(ATTACHMENTS, key);
      const threads = Object.entries(held.threads).flatMap(([id, list]) => {
        const left = list.filter(k => !going.has(k.key));
        return left.length === 0 ? [] : [[id, left] as const];
      });
      return { threads: Object.fromEntries(threads) };
    });
  /** The keys of the images a start's message carried, which the host keeps while the start is in the transcript. */
  const imageKeysOf = (e: SessionEvent): string[] =>
    e.type !== "session.start" || e.threadId === undefined
      ? []
      : (e.attachments ?? []).flatMap((a, index) => {
          const key = isImage(a.mediaType) ? attachmentKey(e.threadId!, e.requestId, index) : undefined;
          return key === undefined ? [] : [key];
        });
  /** A trim's `gone` that lets the dropped starts' images go once the trim is done. */
  const trimming = (workspaceId: string, also?: (e: SessionEvent) => void): { gone: (e: SessionEvent) => void; done: () => void } => {
    const keys: string[] = [];
    return {
      gone: e => {
        also?.(e);
        keys.push(...imageKeysOf(e));
      },
      done: () => void (keys.length > 0 ? dropKeptKeys(workspaceId, keys) : undefined),
    };
  };
  /** Takes these threads' kept images away, or every one of the workspace's. */
  const dropSentImages = (workspaceId: string, threadIds: readonly string[] | "all"): Promise<void> =>
    onKept(workspaceId, async held => {
      const going = threadIds === "all" ? Object.keys(held.threads) : threadIds.filter(id => held.threads[id] !== undefined);
      if (going.length === 0) return undefined;
      for (const id of going) for (const k of held.threads[id] ?? []) await store.deleteBlob(ATTACHMENTS, k.key);
      return { threads: Object.fromEntries(Object.entries(held.threads).filter(([id]) => !going.includes(id))) };
    });

  /** Drops events until the rest are inside both caps, in place, and answers the bytes left; each dropped event goes
   * to `gone`. Every thread of a project's folder shares one transcript, and trimming it oldest first let a busy
   * thread take a quiet thread's every event while its row stayed, so that thread opened on a blank page. So what
   * goes first is the oldest event of the thread holding the most, outside each thread's newest turn, which no
   * other thread's traffic takes; only a transcript still over its caps with nothing else left loses the oldest of
   * what remains. The newest event stays. */
  const dropOldest = (events: SessionEvent[], bytes: number = events.reduce((n, e) => n + eventBytes(e), 0), gone?: (e: SessionEvent) => void): number =>
    // Sizes are read only where the bytes are what is over: a transcript over its count alone is trimmed by count.
    dropOldestOf(events, bytes, bytes > TRANSCRIPT_BYTES ? sizeOf : eventBytes, gone);
  /** dropOldest over anything that names a thread and a type, each weighed by `weigh`. */
  const dropOldestOf = <E extends { threadId?: string; type: string }>(events: E[], bytes: number, weigh: (e: E) => number, gone?: (e: E) => void): number => {
    if (events.length <= TRANSCRIPT_CAP && bytes <= TRANSCRIPT_BYTES) return bytes;
    // Each thread's newest turn starts at its last start, or is its last event where it has none.
    const lastStart = new Map<string, number>();
    const lastEvent = new Map<string, number>();
    events.forEach((e, i) => {
      const key = e.threadId ?? "";
      lastEvent.set(key, i);
      if (e.type === "session.start") lastStart.set(key, i);
    });
    const byteBound = bytes > TRANSCRIPT_BYTES;
    const threads = new Map<string, { at: number[]; next: number; bytes: number }>();
    events.forEach((e, i) => {
      const key = e.threadId ?? "";
      if (i >= (lastStart.get(key) ?? lastEvent.get(key)!)) return;
      const held = threads.get(key) ?? { at: [], next: 0, bytes: 0 };
      held.at.push(i);
      if (byteBound) held.bytes += weigh(e);
      threads.set(key, held);
    });
    const dropped = new Set<number>();
    let count = events.length;
    const drop = (i: number): void => {
      dropped.add(i);
      bytes -= weigh(events[i]!);
      count--;
    };
    while (count > TRANSCRIPT_CAP || bytes > TRANSCRIPT_BYTES) {
      const byBytes = bytes > TRANSCRIPT_BYTES;
      let most: { at: number[]; next: number; bytes: number } | undefined;
      for (const held of threads.values()) {
        if (held.next >= held.at.length) continue;
        if (most === undefined || (byBytes ? held.bytes > most.bytes : held.at.length - held.next > most.at.length - most.next)) most = held;
      }
      if (most === undefined) break;
      const i = most.at[most.next++]!;
      if (byteBound) most.bytes -= weigh(events[i]!);
      drop(i);
    }
    for (let i = 0; i < events.length - 1 && (count > TRANSCRIPT_CAP || bytes > TRANSCRIPT_BYTES); i++) if (!dropped.has(i)) drop(i);
    if (dropped.size === 0) return bytes;
    let kept = 0;
    for (let i = 0; i < events.length; i++) {
      if (dropped.has(i)) gone?.(events[i]!);
      else events[kept++] = events[i]!;
    }
    events.length = kept;
    return bytes;
  };
  /** dropOldest with the dropped starts' images let go after it. */
  const trimmed = (workspaceId: string, events: SessionEvent[], bytes?: number, also?: (e: SessionEvent) => void): number => {
    const trim = trimming(workspaceId, also);
    const left = dropOldest(events, bytes, trim.gone);
    trim.done();
    return left;
  };
  const trimTranscript = (workspaceId: string, events: SessionEvent[]): void =>
    void transcriptBytes.set(workspaceId, trimmed(workspaceId, events, transcriptBytes.get(workspaceId), e => forgetChild(indexFor(workspaceId), e)));
  /** A transcript held as the one opened last, the oldest of the others let go past the cap. */
  const holdTranscript = (workspaceId: string, events: SessionEvent[]): void => {
    transcripts.delete(workspaceId);
    transcripts.set(workspaceId, events);
    for (const id of transcripts.keys()) {
      if (transcripts.size <= TRANSCRIPTS_HELD) break;
      transcripts.delete(id);
      transcriptBytes.delete(id);
    }
  };
  /** A workspace's transcript, from its own file beside the state file: kept inside the state file, every turn's
   * flush rewrote every workspace's transcript with it, and a host whose file had grown to hundreds of megabytes
   * spent its loop on that for minutes. */
  const transcriptBlob = (record: TranscriptRecord): Buffer => Buffer.from(JSON.stringify(record));
  /** A transcript file's events, nothing where there is no file, and a refusal where there is a file that did not
   * read: a caller that took the two for one wrote what it held over everything the file had. A file that reads and
   * does not parse never will, and refusing it would keep every later event unwritten, so its bytes are moved aside
   * under a name of their own and it counts as no file. */
  const readTranscript = async (workspaceId: string, collection: string = TRANSCRIPTS): Promise<SessionEvent[] | undefined> => {
    let bytes: Buffer | undefined;
    try {
      bytes = await store.getBlob(collection, workspaceId);
      if (bytes === undefined && (await store.statBlob(collection, workspaceId)) === undefined) return undefined;
    } catch (e) {
      throw new Error(transcriptUnreadLine(workspaceId, e instanceof Error ? e.message : String(e)));
    }
    if (bytes === undefined) throw new Error(transcriptUnreadLine(workspaceId, "the file is there and could not be read"));
    try {
      const events = (JSON.parse(bytes.toString("utf8")) as Partial<TranscriptRecord>).events;
      if (!Array.isArray(events)) throw new Error("it holds no events");
      return numbered(events);
    } catch (e) {
      const aside = `${workspaceId}.${Date.now()}`;
      await store.putBlob(`${collection}-unparsed`, aside, bytes);
      await store.deleteBlob(collection, workspaceId);
      console.warn(`the transcript of ${workspaceId} does not parse (${e instanceof Error ? e.message : String(e)}), so its bytes are kept as ${collection}-unparsed/${aside} and it starts again empty`);
      return undefined;
    }
  };
  /** The index written beside a transcript, marked with the transcript file as it stands now. */
  const writeIndex = async (workspaceId: string, index: TranscriptIndex): Promise<void> => {
    const bytes = indexBytes(index, await store.statBlob(TRANSCRIPTS, workspaceId));
    await store.putBlob(TRANSCRIPT_INDEX, workspaceId, bytes);
  };
  /** A transcript an older build kept inside the state file, merged into what its files already hold: an older build
   * run on this state after this one writes its new events there again, and a move cut short by a crash leaves both
   * copies. Every event is kept once, by its JSON, in the order its stamp says. The tail inside the byte cap is what
   * this host holds and flushes; everything before it goes to the head file, which nothing trims. */
  const moveTranscript = async (moving: TranscriptRecord): Promise<void> => {
    const id = moving.workspaceId;
    const seen = new Set<string>();
    const all: SessionEvent[] = [];
    for (const read of [...((await readTranscript(id, TRANSCRIPT_HEADS)) ?? []), ...((await readTranscript(id)) ?? []), ...moving.events]) {
      // Positions are given again below, so the same event read off two copies is still one.
      const e = { ...read };
      delete e.pos;
      const key = JSON.stringify(e);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(e);
    }
    all.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    all.forEach((e, i) => (e.pos = i + 1));
    const held = [...all];
    dropOldest(held);
    const kept = new Set(held);
    const head = all.filter(e => !kept.has(e));
    if (head.length > 0) await store.putBlob(TRANSCRIPT_HEADS, id, transcriptBlob({ workspaceId: id, events: head }));
    await store.putBlob(TRANSCRIPTS, id, transcriptBlob({ workspaceId: id, events: held }));
    const index = indexOf(held);
    transcriptIndex.set(id, index);
    await writeIndex(id, index);
  };
  /** The index a workspace's transcript left beside it where it was read off the file as it stands, else one read off
   * the transcript itself: an index older than its file answers search and a send from before the last turn. */
  const loadIndex = async (workspaceId: string): Promise<void> => {
    if (rows !== undefined) return loadRowsIndex(rows, workspaceId);
    try {
      const mark = await store.statBlob(TRANSCRIPTS, workspaceId).catch((e: unknown) => {
        throw new Error(transcriptUnreadLine(workspaceId, e instanceof Error ? e.message : String(e)));
      });
      if (mark === undefined) return;
      const bytes = await store.getBlob(TRANSCRIPT_INDEX, workspaceId);
      const kept = bytes === undefined ? undefined : indexRead(bytes);
      if (kept?.of !== undefined && kept.of.bytes === mark.bytes && kept.of.at === mark.at) {
        transcriptIndex.set(workspaceId, kept.index);
        return;
      }
      const index = indexOf((await readTranscript(workspaceId)) ?? []);
      transcriptIndex.set(workspaceId, index);
      await writeIndex(workspaceId, index).catch((e: unknown) => console.warn(`the transcript index of ${workspaceId} was not written: ${e instanceof Error ? e.message : String(e)}`));
    } catch (e) {
      console.warn(`${e instanceof Error ? e.message : String(e)}, so search and a send leave it out until it reads`);
    }
  };
  /** On rows the index is written in the transaction that changes them, so the one kept is the one read; a workspace
   * whose rows have none (the move found none that matched its blob) has one read off the rows and written. */
  const loadRowsIndex = (rows: TranscriptRows, workspaceId: string): void => {
    let newest: number | undefined;
    try {
      newest = rows.newestPos(workspaceId);
      const json = rows.index(workspaceId);
      const kept = json === undefined ? undefined : indexRead(Buffer.from(json));
      if (kept !== undefined) return void transcriptIndex.set(workspaceId, kept.index);
      const { events } = rows.all(workspaceId);
      if (events.length === 0) return;
      const index = indexOf(events);
      rows.putIndex(workspaceId, indexBytes(index, undefined).toString("utf8"));
      transcriptIndex.set(workspaceId, index);
    } catch (e) {
      console.warn(`${transcriptUnreadLine(workspaceId, e instanceof Error ? e.message : String(e))}, so search and a send leave it out until it reads`);
      // Positions go on after the newest row: issued again from one, the next flush would meet rows already kept and
      // write none of its events.
      if (newest !== undefined) transcriptIndex.set(workspaceId, { ...emptyIndex(), pos: newest });
      unreadIndexes.add(workspaceId);
    }
  };
  /** The transcripts an earlier build kept as blobs, moved into rows once: what was moved is said in one line. */
  const moveBlobs = (rows: TranscriptRows): void => {
    const done = rows.moveBlobs();
    for (const u of done.setAside) console.warn(`the transcript of ${u.workspaceId} could not move into the state database (${u.why}), so its bytes are kept as ${TRANSCRIPTS}-unparsed/${u.aside} and it starts again empty`);
    if (done.moved > 0) console.warn(`moved ${done.moved === 1 ? "1 transcript" : `${done.moved} transcripts`} (${done.events} events) into the state database`);
  };
  // Every read and write of one workspace's transcript file takes its turn here, so the later snapshot always lands
  // last whatever order the store finishes in, and a read never lands between a flush's write and the moment the
  // events it wrote stop counting as unwritten.
  const transcriptQueue = new Map<string, Promise<void>>();
  const onTranscriptQueue = <T>(workspaceId: string, step: () => Promise<T>): Promise<T> => {
    const run = (transcriptQueue.get(workspaceId) ?? Promise.resolve()).then(step);
    transcriptQueue.set(workspaceId, run.then(() => {}, () => {}));
    return run;
  };
  /** A workspace's transcript whole: held already, or its file and what was written since, read on demand. The copy
   * this answers is the one to use: another open can let it go from the held ones at any await, so a caller never
   * looks it up again. */
  const openTranscript = (workspaceId: string): Promise<SessionEvent[]> => {
    if (rows !== undefined) return Promise.resolve(openRows(rows, workspaceId));
    const held = transcripts.get(workspaceId);
    if (held !== undefined) {
      holdTranscript(workspaceId, held);
      return Promise.resolve(held);
    }
    return onTranscriptQueue(workspaceId, () => openInQueue(workspaceId));
  };
  /** The open itself, run inside the queue. A transcript that exists is held as the one opened last; one with no file
   * and nothing written, or of a workspace deleted meanwhile, is answered and not held. */
  const openInQueue = async (workspaceId: string): Promise<SessionEvent[]> => {
    const landed = transcripts.get(workspaceId);
    if (landed !== undefined) return landed;
    const read = await readTranscript(workspaceId);
    const events = [...(read ?? []), ...(pendingEvents.get(workspaceId) ?? [])];
    const bytes = trimmed(workspaceId, events);
    if (events.length > 0 && transcriptIndex.has(workspaceId)) {
      holdTranscript(workspaceId, events);
      transcriptBytes.set(workspaceId, bytes);
    }
    return events;
  };
  /** On a store that keeps transcripts as rows, none is held: an open reads the rows, with what was written since
   * after them, trimmed as a flush would trim them. Nothing is let go: a start the read drops is still a row until a
   * flush drops it, and its images go then. */
  const openRows = (rows: TranscriptRows, workspaceId: string): SessionEvent[] => {
    const kept = rows.all(workspaceId);
    const pending = pendingEvents.get(workspaceId) ?? [];
    const events = [...kept.events, ...pending];
    dropOldest(events, kept.size + (pendingBytes.get(workspaceId) ?? 0));
    return events;
  };
  /** One thread's events read off the transcript as openTranscript answers it, or on rows off the thread's index, the
   * events written since the last flush first. */
  const transcriptReader: TranscriptReader = {
    read: async (workspaceId, threadId, o) => {
      const pos = transcriptIndex.get(workspaceId)?.pos ?? 0;
      if (rows === undefined) return { ...readThread(await openTranscript(workspaceId), threadId, o), pos };
      const pending = (pendingEvents.get(workspaceId) ?? []).filter(e => e.threadId === threadId);
      const newest = function* (): Generator<SessionEvent> {
        for (let i = pending.length - 1; i >= 0; i--) yield pending[i]!;
        yield* rows.newest(workspaceId, threadId, o.before);
      };
      return { events: pickNewest(newest(), o), total: rows.count(workspaceId, threadId) + pending.length, pos };
    },
  };
  /** Inside the queue: `events` written as the transcript, the first `took` events written since the last flush
   * cleared the moment the file has them, and the index made again off what was written. */
  const writeTranscript = async (workspaceId: string, events: SessionEvent[], took: number): Promise<void> => {
    await store.putBlob(TRANSCRIPTS, workspaceId, transcriptBlob({ workspaceId, events }));
    // Before the index is written, so an index write that fails cannot leave these to be written a second time.
    const pending = pendingEvents.get(workspaceId);
    pending?.splice(0, took);
    if (pending !== undefined && pending.length === 0) {
      pendingEvents.delete(workspaceId);
      pendingBytes.delete(workspaceId);
    } else if (pending !== undefined) pendingBytes.set(workspaceId, pending.reduce((n, e) => n + eventBytes(e), 0));
    const index = indexOf(events);
    index.pos = Math.max(index.pos, transcriptIndex.get(workspaceId)?.pos ?? 0);
    // An index that did not land keeps its old mark, and boot reads that transcript again.
    await writeIndex(workspaceId, index).catch((e: unknown) => console.warn(`the transcript index of ${workspaceId} was not written: ${e instanceof Error ? e.message : String(e)}`));
    // What arrived during the writes is folded on after them, as record folded it on the index this replaces.
    for (const e of pendingEvents.get(workspaceId) ?? []) foldEvent(index, e);
    if (transcriptIndex.has(workspaceId)) transcriptIndex.set(workspaceId, index);
  };
  /** Takes the events `drops` names out of a transcript, the file and what was written since alike, and writes it: one
   * turn of the queue on the copy the open answered, so nothing can let that copy go between the change and the
   * write, and no flush runs between them. */
  const dropFromTranscript = (workspaceId: string, drops: (e: SessionEvent) => boolean): Promise<void> =>
    onTranscriptQueue(workspaceId, async () => {
      if (rows !== undefined) return settleRows(rows, workspaceId, drops);
      const events = await openInQueue(workspaceId);
      for (let i = events.length - 1; i >= 0; i--) if (drops(events[i]!)) events.splice(i, 1);
      transcriptBytes.delete(workspaceId);
      const pending = pendingEvents.get(workspaceId) ?? [];
      for (let i = pending.length - 1; i >= 0; i--) if (drops(pending[i]!)) pending.splice(i, 1);
      await writeTranscript(workspaceId, [...events], pending.length);
    });
  /** Inside the queue, on rows: what was written since the last flush appended, the events `drops` names taken out
   * and the oldest past the caps dropped, in one transaction with the index beside them. The rows are read again for
   * the index only where events went, since record folded every event that came. */
  const settleRows = (rows: TranscriptRows, workspaceId: string, drops?: (e: SessionEvent) => boolean): void => {
    const pending = pendingEvents.get(workspaceId) ?? [];
    const trim = trimming(workspaceId);
    let index = transcriptIndex.get(workspaceId) ?? emptyIndex();
    rows.atomically(() => {
      rows.append(workspaceId, drops === undefined ? pending : pending.filter(e => !drops(e)));
      let lost = drops !== undefined && pending.some(drops);
      if (drops !== undefined) {
        const going = rows.all(workspaceId).events.filter(drops);
        rows.remove(workspaceId, going.map(e => e.pos!));
        lost ||= going.length > 0;
      }
      const { count, size } = rows.total(workspaceId);
      if (count > TRANSCRIPT_CAP || size > TRANSCRIPT_BYTES) {
        const going: EventSize[] = [];
        dropOldestOf(rows.sizes(workspaceId), size, e => e.size, e => void going.push(e));
        // Only a start carries images, so only starts are read before they go.
        for (const e of rows.at(workspaceId, going.filter(g => g.type === "session.start").map(g => g.pos))) trim.gone(e);
        rows.remove(workspaceId, going.map(g => g.pos));
        lost ||= going.length > 0;
      }
      if (lost) {
        const issued = index.pos;
        index = indexOf(rows.all(workspaceId).events);
        index.pos = Math.max(index.pos, issued);
        unreadIndexes.delete(workspaceId);
      }
      if (!unreadIndexes.has(workspaceId)) rows.putIndex(workspaceId, indexBytes(index, undefined).toString("utf8"));
    });
    trim.done();
    pendingEvents.delete(workspaceId);
    pendingBytes.delete(workspaceId);
    if (transcriptIndex.has(workspaceId)) transcriptIndex.set(workspaceId, index);
  };
  const transcriptTimers = new Map<string, () => void>();
  // One token per machine, written to a guest the first time a client asks to reach its daemon; the file the
  // guest carried before (the golden's, or an earlier run's) stops working then. Per machine and not per process:
  // a machine whose root is hostile reads its own token file, and that token opens no other machine of this host.
  const daemonSeed = opts.daemonToken;
  if (daemonSeed !== undefined) assertTokenShape(daemonSeed);
  const machineTokens = new Map<string, string>();
  /** The token this machine is given, made once and kept: derived from the seed a caller pinned, or random. */
  const tokenForMachine = (machineId: string): string => {
    const held = machineTokens.get(machineId);
    if (held !== undefined) return held;
    const minted = daemonSeed === undefined ? randomBytes(24).toString("hex") : daemonTokenFor(daemonSeed, machineId);
    machineTokens.set(machineId, minted);
    return minted;
  };
  // Whether each machine answered a daemon, keyed by machine id: a resurrect or upgrade brings a fresh guest and file.
  const daemonTokens = new Map<string, { hasDaemon: boolean; at: number }>();
  const daemonTokenOf = async (machine: Machine, path?: string): Promise<string | undefined> => {
    const token = tokenForMachine(machine.id);
    const cached = daemonTokens.get(machine.id);
    if (cached && (cached.hasDaemon || Date.now() - cached.at < DAEMON_TOKEN_MISS_TTL_MS)) return cached.hasDaemon ? token : undefined;
    const hasDaemon = await rotateDaemonToken(machine, token, daemonTokenPathOf(machine, path));
    daemonTokens.set(machine.id, { hasDaemon, at: Date.now() });
    return hasDaemon ? token : undefined;
  };

  const cancelFlush = (workspaceId: string): void => {
    transcriptTimers.get(workspaceId)?.();
    transcriptTimers.delete(workspaceId);
  };

  /** The flushes queued and not yet begun, so a burst of asks is one write. */
  const flushesQueued = new Map<string, Promise<void>>();
  /** The transcripts whose file did not read at their last flush, so the refusal is said once. */
  const unreadSaid = new Set<string>();
  // The copy is taken when the flush's turn comes, not per event: a store may serialise after it returns, and the
  // events keep arriving under it. A transcript not held is its file with what was written since appended.
  const flushTranscript = (workspaceId: string): Promise<void> => {
    cancelFlush(workspaceId);
    const queued = flushesQueued.get(workspaceId);
    if (queued !== undefined) return queued;
    const flush = onTranscriptQueue(workspaceId, async () => {
      flushesQueued.delete(workspaceId);
      if (rows !== undefined) return pendingEvents.has(workspaceId) ? settleRows(rows, workspaceId) : undefined;
      const held = transcripts.get(workspaceId);
      if (held === undefined && !pendingEvents.has(workspaceId)) return;
      let events: SessionEvent[];
      if (held !== undefined) events = [...held];
      else {
        let read: SessionEvent[] | undefined;
        try {
          read = await readTranscript(workspaceId);
        } catch (e) {
          // What was written since stays unwritten for the next flush, and the file keeps what it has. Said once
          // until a flush lands, since every event past the threshold asks again.
          if (!unreadSaid.has(workspaceId)) console.warn(`${e instanceof Error ? e.message : String(e)}, so nothing is written over it and its newest events wait for the next flush`);
          unreadSaid.add(workspaceId);
          return;
        }
        events = [...(read ?? []), ...(pendingEvents.get(workspaceId) ?? [])];
        trimmed(workspaceId, events);
      }
      unreadSaid.delete(workspaceId);
      await writeTranscript(workspaceId, events, pendingEvents.get(workspaceId)?.length ?? 0);
    });
    const settled = flush.catch(() => {});
    flushesQueued.set(workspaceId, settled);
    return settled;
  };

  const capSessions = (workspaceId: string): void => {
    const rows = [...sessions].filter(([, s]) => s.view.workspaceId === workspaceId);
    const excess = rows.length - SESSION_INDEX_CAP;
    if (excess <= 0) return;
    const finished = rows.filter(([, s]) => s.view.status !== "running").sort(([, a], [, b]) => (a.view.startedAt ?? 0) - (b.view.startedAt ?? 0));
    for (const [id] of finished.slice(0, excess)) sessions.delete(id);
  };

  // Rows are copied at queue time, like the transcript: the store may serialise after it returns. A harness that
  // settles after its workspace was deleted must not write the document back.
  /** Every workspace's viewed marks, by path against the blob id each file had when it was marked; kept on the session
   * index so they outlive the host and go with the workspace. */
  const viewedMarks = new Map<string, Record<string, string>>();

  const persistSessions = (workspaceId: string): Promise<void> => {
    if (!live.has(workspaceId)) return Promise.resolve();
    // Every road a turn settles by comes through here, its own end, a cut and the restart load alike, so a settled
    // row that did work marks its thread's record before the cap can drop the row that says so.
    for (const { view } of sessions.values()) {
      const record = view.threadId === undefined || view.workspaceId !== workspaceId ? undefined : threadRecords.get(view.threadId);
      if (record?.worked === false && view.status !== "running" && threadRan([view])) threadRecords.set(view.threadId!, { ...record, worked: true });
    }
    capSessions(workspaceId);
    const rows = [...sessions.values()]
      .filter(s => s.view.workspaceId === workspaceId && s.launch === undefined)
      .map(s => ({
        ...s.view,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.notifyBy !== undefined ? { notifyBy: s.notifyBy } : {}),
        ...(s.notifyRoad !== undefined ? { notifyRoad: s.notifyRoad } : {}),
        ...(s.view.status === "running" && s.turnLive?.reply !== undefined ? { reply: s.turnLive.reply } : {}),
        ...(s.view.status === "running" && s.turnLive?.told !== undefined ? { told: s.turnLive.told } : {}),
        ...(s.view.status === "running" && s.turnLive?.toldLast === true ? { toldLast: true as const } : {}),
        ...(s.view.status === "running" && s.turnLive?.steered !== undefined ? { steered: s.turnLive.steered } : {}),
        ...(s.view.status === "running" && s.run !== undefined ? { run: s.run } : {}),
        ...(s.view.status === "running" && s.from !== undefined ? { from: s.from } : {}),
        ...(s.view.status === "running" && s.asked !== undefined ? { asked: s.asked } : {}),
        ...(s.view.status === "running" && s.turnToken !== undefined ? { turnToken: s.turnToken } : {}),
        // Beside the turn token and for the same reason: the process out there still holds this device, so a host
        // that re-opens the turn has to know which one to take away when it ends.
        ...(s.view.status === "running" && s.scopeDeviceId !== undefined ? { scopeDeviceId: s.scopeDeviceId } : {}),
        ...(s.snapshot !== undefined ? { snapshot: s.snapshot } : {}),
      }));
    const threads: Record<string, ThreadRecord> = {};
    for (const [threadId, { workspaceId: on, ...held }] of threadRecords) if (on === workspaceId) threads[threadId] = held;
    const marks = viewedMarks.get(workspaceId);
    const snapshot: SessionIndexRecord = { workspaceId, sessions: rows, threads, ...(marks !== undefined && Object.keys(marks).length > 0 ? { viewed: marks } : {}) };
    const queued = (indexFlushes.get(workspaceId) ?? Promise.resolve())
      .then(() => store.put(SESSIONS, workspaceId, snapshot))
      .catch(() => {});
    indexFlushes.set(workspaceId, queued);
    return queued;
  };

  // Deltas are only appended in memory; the store sees the transcript at turn
  // boundaries, so a crash mid-turn loses that turn's partial output and
  // nothing else. A session's end is written at once, anything before it waits
  // for the debounce.
  const record = (unstamped: SessionEvent): void => {
    const event: SessionEvent = { ...unstamped, at: Date.now(), pos: indexFor(unstamped.workspaceId).pos + 1 };
    const id = event.workspaceId;
    // A subagent's text and thinking are clipped as a tool result is, so a subagent that thinks for pages cannot push its
    // lead's own lines out of the ring.
    const clipped = event.type === "session.delta" && event.text.length > TOOL_RESULT_KEPT && (event.kind === "tool_result" || (event.parentToolUseId !== undefined && (event.kind === "text" || event.kind === "thinking")));
    const kept = clipped ? { ...event, text: event.text.slice(0, TOOL_RESULT_KEPT) } : event;
    const size = eventBytes(kept);
    const held = transcripts.get(id);
    if (held !== undefined) {
      held.push(kept);
      const had = transcriptBytes.get(id);
      if (had !== undefined) transcriptBytes.set(id, had + size);
      trimTranscript(id, held);
    }
    const pending = pendingEvents.get(id) ?? [];
    pending.push(kept);
    pendingEvents.set(id, pending);
    const unwritten = (pendingBytes.get(id) ?? 0) + size;
    pendingBytes.set(id, unwritten);
    foldEvent(indexFor(id), kept);
    if (event.type === "session.end" || unwritten > PENDING_FLUSH_BYTES) void flushTranscript(event.workspaceId);
    else if (event.type !== "session.delta" && !transcriptTimers.has(event.workspaceId)) {
      transcriptTimers.set(event.workspaceId, clock.schedule(() => void flushTranscript(event.workspaceId), TRANSCRIPT_FLUSH_MS));
    }
    bus.emit(event);
    if ((event.type === "session.start" || event.type === "session.end") && event.threadId !== undefined) ctx.pushHead(event.threadId);
  };

  /** The newest accrued cost each workspace's meter pushed, for a slate's cost source. */
  const accrued = new Map<string, number>();
  bus.on("workspace.cost", e => {
    if (e.type === "workspace.cost") accrued.set(e.workspaceId, e.accruedUsd);
  });
  /** The model, effort and window a thread's turns ran on, read off its rows as the composer reads them, and the model
   * and the effort past the index cap off its session's newest start. */
  const ranOn = (workspaceId: string, threadId: string, session: string | undefined): RanPicks => {
    const recorded = recordedPicks(ctx.rowsOn(threadId).filter(r => r.workspaceId === workspaceId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)));
    if (session === undefined) return recorded;
    const model = recorded.model === undefined ? ctx.resumedFact(workspaceId, session, "model") : undefined;
    const effort = recorded.effort === undefined ? ctx.resumedFact(workspaceId, session, "effort") : undefined;
    return { ...(model !== undefined ? modelPicks(model) : {}), ...(effort !== undefined ? { effort } : {}), ...recorded };
  };
  /** The workspace a thread runs on where that is a machine of its own, not this computer. */
  const boxOf = (threadId: string): LiveWorkspace | undefined => {
    const workspaceId = ctx.latestOn(threadId)?.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
    const entry = workspaceId === undefined ? undefined : live.get(workspaceId);
    return entry === undefined || isLocalWorkspace(entry.record) ? undefined : entry;
  };
  return {
    keptWrites, keepSentImages, dropSentImages, moveTranscript, loadIndex, moveBlobs, transcriptQueue, openTranscript,
    transcriptReader, dropFromTranscript, transcriptTimers, daemonTokens, daemonTokenOf, cancelFlush, flushTranscript,
    viewedMarks, persistSessions, record, accrued, ranOn, boxOf,
  };
}
