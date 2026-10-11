// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { OWNER_LABEL, goldenHead, isMissing, readGone, sightMachine, type Machine, type MachineBackend, isNoProvider, isPlaceAbsent } from "@wsp/engine";
import { type AcrossAct, type PlaceKind, type ProjectView, type SessionView, type Caller, type WorkspacePhase, ThreadPlacement, ThreadScope, TurnStatus, WorkspaceOrigin, notTheLeadsChildRefusal, foldThreads, threadKeyOf, threadWord, scopeOf, goneWords, NO_IMAGE_YET, noWorkspaceRefusal, notFoundRefusal, goneUnconfirmedLine, type GoneSeenBy, copiesFolder, kindForComputer, RUN_GONE_LINE, HERE_PLACE_ID, workspaceLands, type ThreadFacts, threadSettled, refusal, LIMIT_RESUME_PROMPT, heldUntil, capRestartedLine, tableName, threadsFollowed, LINK_RETRY_WINDOW_MS } from "@wsp/protocol";
import { keyOf } from "../agent-setup.js";
import { harnessCatalog } from "../harness-catalog.js";
import { accountOnComputer } from "../usage.js";
import { phaseLeavingGone, providerSaid } from "../status.js";
import type { WorkspaceRecord, LiveWorkspace, FoundMachine } from "../types/wiring.js";
import { WORKSPACES, PROJECTS, TRANSCRIPTS, SESSIONS, HELD_STARTS, type HeldStartRecord, READS, READS_ID, RESTARTED_REASON, goneLogLine, labelOf, restartCutLine, turnWritten, type TranscriptRecord, type TurnLive, type TurnAsked, readAsked, readScope, readRoad, readSteered, type ThreadRecord, type ThreadStamps, type TreeTalk, type SessionIndexRecord, BUILDERS, OWNER, HELD_TTL_MS, pidAlive, type BuilderRecord, type LiveBuilder, deadMachine, isAbsentMachine, absentMachine, type StoredBuilder } from "../types/internal.js";
import type { RuntimeContext, BootArea } from "../context.js";

/** How long the load waits on the provider's reads of its records' machines, all of them together. A host answers
 * its app off its records: twenty reads one after another at a slow provider held a start past the app's wait. */
export const LOAD_READS_MS = 1_500;

/** The load's one deadline, and every read still out at it by the record it was for. */
interface LoadReads {
  until: number;
  late: Map<string, Promise<Machine>>;
}

/** What a record held while its machine's read is still out says if anything asks it before the read lands. */
const lateReadLine = (machineId: string): string => `the provider has not yet answered for ${machineId}; it is read in once it does`;

export function bootArea(ctx: RuntimeContext): BootArea {
  const {
    store, local, placeDoor, bus, clock, hostId, deviceDoor, live, projectsHeld, setups, builders, threadRecords,
    wakeAt, sessions, rows, transcriptIndex, places,
  } = ctx;
  /** Whether a seal can still be taken from a builder at this place: the machine's own first life, or a provider
   * whose copy of a disk is the disk as it stands. The one place the golden road asks it; every reader above the
   * runtime takes the answer on the builder's view. A place nothing here can reach yet answers on first life
   * alone, which is what the record already says. */
  const sealableAt = (place: string | undefined, firstLife: boolean): boolean => {
    if (firstLife) return true;
    const at = places.backend(place ?? places.wired) ?? placeDoor?.backendOf(place ?? places.wired);
    return at?.capabilities.snapshotsAnyLife === true;
  };
  const lifeOf = (stored: StoredBuilder, machine: Machine, sealable: boolean): LiveBuilder["life"] => {
    // Only a label that names another state file makes it foreign; a view with no labels is ours.
    const label = machine.labels?.[OWNER_LABEL];
    // A hold from this host is checked against its pid; one from another host is trusted while its heartbeat
    // is fresh, and a heartbeat that cannot be read counts as fresh: when unsure, the builder is held.
    const holder = stored.heldBy;
    const mine = holder !== undefined && holder.host === hostId && holder.pid === process.pid;
    const beatAge = holder !== undefined ? Date.now() - Date.parse(holder.heartbeat) : Number.NaN;
    const fresh = Number.isNaN(beatAge) || beatAge < HELD_TTL_MS;
    const held = holder !== undefined && !mine && fresh && (holder.host !== hostId || pidAlive(holder.pid));
    // A placeholder its dead holder left mid-setup never finished its stages: stale, whatever the marker says.
    return label !== undefined && label !== ctx.state.owner ? "foreign" : held ? "held" : !sealable || stored.building === true ? "stale" : "reusable";
  };
  const liveOf = (record: BuilderRecord, machine: Machine): LiveBuilder => {
    const sealable = sealableAt(record.place, record.firstLife);
    return {
      record,
      builder: {
        machine, kind: record.kind, baseTemplate: record.baseTemplate, setupSha: record.setupSha, createdAt: record.createdAt, firstLife: record.firstLife, size: record.size,
        ...(record.import !== undefined ? { import: record.import } : {}),
        ...(record.base !== undefined ? { base: record.base } : {}),
      },
      sealable,
      life: lifeOf(record, machine, sealable),
    };
  };
  /** A stored record this process has no entry for yet; its machine is fetched once, here. */
  const admit = async (stored: StoredBuilder): Promise<void> => {
    // A builder made at another place is read on that place's backend; the wired one has never heard of it. A
    // joined computer that has never said what it forks with cannot be asked, and one that is not connected
    // answers absent: either way the record stays as it is until that computer dials in, and only a place that
    // reads the machine gone through readGone drops it; one it still finds is admitted at the next refresh.
    const place = stored.place ?? places.wired;
    const at = places.backend(place) ?? placeDoor?.backendOf(place);
    if (at === undefined) return;
    let machine: Machine;
    try {
      machine = ctx.observed(await at.get(stored.id));
    } catch (e) {
      if (isPlaceAbsent(e) || isNoProvider(e)) return;
      if (!isMissing(e)) throw e;
      if ((await readGone(at, stored.id)) === "gone") await store.delete(BUILDERS, stored.id);
      return;
    }
    // A read the load stopped waiting for can land after the host closed.
    if (ctx.state.closed) return;
    // The view get() fetched is read once: a second read would reset the provider's idle timer again.
    const seen = machine.seen;
    const state = seen?.state ?? (await machine.state());
    // A machine found paused was paused: that alone clears the marker for good. Nothing is read from the
    // provider's createdAt: on a running machine never paused, resumed or exec'd it read +6.4 s at two minutes
    // and +306 s at ten (canary, 2026-09-04 UTC), so it moves with no lifecycle event and decides nothing.
    const firstLife = stored.firstLife === true && state === "running";
    const record: BuilderRecord = { ...stored, firstLife, size: stored.size ?? ctx.sizeBuilt(await ctx.shapeOf(machine), at.pricing.defaultSize) };
    if (stored.firstLife === true && !firstLife) await store.put(BUILDERS, record.id, record);
    builders.set(record.id, liveOf(record, machine));
    if (stored.sealed !== undefined) ctx.armGrace(record.id, stored.sealed.at);
  };
  /** One read of a stored builder at a time, which the load and every refresh while it is out share. */
  const admitting = new Map<string, Promise<void>>();
  const admitOnce = (stored: StoredBuilder): Promise<void> => {
    const out = admitting.get(stored.id);
    if (out !== undefined) return out;
    const read = admit(stored);
    admitting.set(stored.id, read);
    const done = (): void => void admitting.delete(stored.id);
    read.then(done, done);
    return read;
  };
  /** The store is the truth across processes, and another wsp (an init beside this host, a second host) writes it
   * after this one hydrated: every decision that kills or reuses a builder reads it first. A row this process has
   * no entry for is admitted, a changed hold or marker re-derives the life, a row another process dropped goes with
   * it. Own records are this process's and are not re-read; no machine is re-read either, so the first-life marker
   * only ever drops here. Passes overlap (a sweep beside a prepare): the newest listing wins, so a pass that finds
   * a newer one started after its own listing applies nothing, drops nothing, and hands its caller the newer pass. */
  let passes = 0;
  let latest: Promise<void> = Promise.resolve();
  const refreshBuilders = (): Promise<void> => (latest = refreshNow(++passes));
  const refreshNow = async (pass: number): Promise<void> => {
    const rows = (await store.list(BUILDERS)) as StoredBuilder[];
    const seen = new Set<string>();
    for (const stored of rows) {
      if (pass !== passes) return latest;
      seen.add(stored.id);
      const current = builders.get(stored.id);
      if (current === undefined) await admitOnce(stored);
      else if (current.life !== "own") {
        const record: BuilderRecord = { ...stored, firstLife: stored.firstLife === true && current.builder.firstLife, size: stored.size ?? current.record.size };
        Object.assign(current, liveOf(record, current.builder.machine));
      }
    }
    if (pass !== passes) return latest;
    for (const [id, b] of [...builders]) if (!seen.has(id) && b.life !== "own") builders.delete(id);
  };

  /** The provider's read of a record's machine, or the one the load already asked. At the load it waits no later
   * than the load's one deadline: a read still out then leaves the record held on the word it was left with, and the
   * read goes on, for the record's boot work to load once it lands. */
  const readWithin = (at: MachineBackend, stored: WorkspaceRecord, load: LoadReads | undefined, held: (e: unknown) => Machine, asked = at.get(stored.machineId)): Promise<Machine> => {
    if (load === undefined) return asked;
    return new Promise<Machine>((resolve, reject) => {
      const cancel = clock.schedule(
        () => {
          load.late.set(stored.id, asked);
          resolve(held(new Error(lateReadLine(stored.machineId))));
        },
        Math.max(0, load.until - clock.now()),
        { unref: true },
      );
      asked.then(
        machine => (cancel(), resolve(machine)),
        (e: unknown) => (cancel(), reject(e)),
      );
    });
  };

  /** A record the load held while its machine's read was still out, loaded once that read lands as an on-time read
   * is: a read that failed holds the record on what the provider said, then takes the road every held record takes.
   * Answers the entry whose daemon wants syncing, as the load does. */
  const loadLate = async (id: string, read: Promise<Machine>): Promise<LiveWorkspace | undefined> => {
    ctx.rereading.add(id);
    let landed: LiveWorkspace | undefined;
    try {
      await read.catch(() => undefined);
      const raw = await store.get(WORKSPACES, id);
      if (raw !== undefined && !ctx.state.closed) landed = await hydrateWorkspace(raw, undefined, undefined, read);
    } catch (e) {
      console.warn(`workspace ${id} was not loaded once its provider answered: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      ctx.rereading.delete(id);
    }
    if (!ctx.state.closed && isHeldAway(id)) await rereadHeld(id, "record load");
    return landed;
  };

  /** Whether this host holds that workspace by a stand-in for a machine it could not ask anything about: the one
   * reading of "nothing is known about this one yet", which is what a place dialling in is the moment to fix. A
   * record with no live entry at all reads the same, since a hydration that never ran holds nothing either. */
  const isHeldAway = (id: string): boolean => {
    const entry = live.get(id);
    return entry === undefined || isAbsentMachine(entry.machine);
  };

  /** What the provider said to the load's one read of a record now held, quoted when the record settles gone. */
  const heldAnswers = new Map<string, string>();
  /** A record the load held by a stand-in, read again the way a gone verdict is confirmed: a machine the provider
   * finds is loaded onto, one it answers gone for GONE_READS reads in a row settles gone through markGone, and a
   * read that fails leaves the record held for the next sweep. */
  const rereadHeld = async (id: string, by: GoneSeenBy): Promise<void> => {
    const entry = live.get(id);
    if (entry === undefined || !isAbsentMachine(entry.machine) || ctx.rereading.has(id)) return;
    ctx.rereading.add(id);
    try {
      const machineId = entry.record.machineId;
      const seen = await Promise.resolve()
        .then(() => sightMachine(ctx.backendFor(entry.record), machineId))
        .catch(() => undefined);
      if (seen === undefined || ctx.state.closed || live.get(id) !== entry) return;
      if (seen.machine !== undefined) {
        const raw = await store.get(WORKSPACES, id);
        const again = raw === undefined ? undefined : await hydrateWorkspace(raw, seen as FoundMachine);
        if (again !== undefined) void ctx.syncDaemon(again);
        return;
      }
      const answer = heldAnswers.get(id);
      // The stand-in refuses every call with the held line; a gone record stands on the machine every gone load gets.
      await ctx.markGone(ctx.attach(entry.record, deadMachine(machineId)), machineId, goneWords(machineId, { by, at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
    } finally {
      if (!isHeldAway(id)) heldAnswers.delete(id);
      ctx.rereading.delete(id);
    }
  };

  /** One stored workspace read into a live one: what the provider says about its machine decides the phase, and
   * the record follows. Read once for every record at hydration, and again for a record on a place the moment that
   * place dials in, since until then nothing could be asked about its machine. Answers the entry whose daemon wants
   * syncing, since the sync waits out a running turn and only the caller knows when its session rows are in. */
  const hydrateWorkspace = async (raw: unknown, seen?: FoundMachine, load?: LoadReads, asked?: Promise<Machine>): Promise<LiveWorkspace | undefined> => {
    const stored = raw as WorkspaceRecord;
    const kind = stored.kind;
    // A record whose kind this host wired no module for, or whose place forks nothing any more, is left as it
    // was: only the host that owns that machine can serve it.
    let at: MachineBackend;
    try {
      at = ctx.moduleOf(kind).backend(stored as WorkspaceRecord);
    } catch (e) {
      console.warn(`workspace ${stored.id} is left as it was: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // The store is the fleet's truth and get(id) the provider's: a record whose machine the provider lost is
    // gone and one whose machine it holds paused is napping, whatever phase either was left at, and both say so
    // before anything lists it or meters it. A machine nothing can be asked about is neither: a place that is not
    // connected, a host started without its provider key and a provider read that failed all leave the record on
    // the word it was left with, and the host serves the rest rather than failing on the first record it cannot read.
    const goldenKind = (await ctx.imageOf(stored.golden).catch(() => undefined))?.version?.kind ?? "sandbox";
    let missing: string | undefined;
    let absent = false;
    // The kind is the golden's, which the record names: a desktop fork on a computer that is away is a desktop
    // fork, and nothing about it is guessed while nothing can be asked. The stand-in refuses with the error that
    // came back, so every road on the row says the one true thing about why it cannot be read.
    const heldAway = (e: unknown): Machine => {
      absent = true;
      const refusal = e instanceof Error ? e : new Error(String(e));
      return absentMachine(stored.machineId, goldenKind, () => {
        throw refusal;
      });
    };
    const machine =
      seen?.machine ??
      (await readWithin(at, stored, load, heldAway, asked).catch((e: unknown) => {
        if (!isMissing(e)) return heldAway(e);
        // One 404 is not gone: a gateway copy that never held the machine answers it while the other bills on. A live
        // record is held as it was and confirmed once the host serves (rereadHeld), since the reads that confirm a
        // gone machine take seconds each and a fleet the provider expired overnight answers 404 for every record.
        if (stored.phase !== "gone") {
          heldAnswers.set(stored.id, providerSaid(e));
          return heldAway(new Error(goneUnconfirmedLine(stored.machineId, providerSaid(e))));
        }
        missing = providerSaid(e);
        return deadMachine(stored.machineId);
      }));
    // The state rides on the view get() just fetched; a second read would reset the provider's idle timer.
    const atProvider = missing !== undefined ? "gone" : absent ? undefined : (seen?.state ?? machine.seen?.state ?? (await machine.state().catch(() => undefined)));
    // A record left gone leaves it on the one predicate every road out of gone reads, and on nothing else. Any
    // other record follows the provider whatever word it was left with: paused means the pause landed or the
    // resume never did, running means the pause never took or the resume landed with nobody left to write it.
    // Only a machine still starting leaves the stored word standing, and a pausing one then reads napping: a
    // wake resumes it either way.
    const phase: WorkspacePhase =
      atProvider === undefined
        ? stored.phase
        : stored.phase === "gone"
          ? (phaseLeavingGone(atProvider) ?? "gone")
          : atProvider === "gone"
            ? "gone"
            : atProvider === "paused"
              ? "napping"
              : atProvider === "running"
                ? "running"
                : stored.phase === "pausing"
                  ? "napping"
                  : stored.phase;
    const record: WorkspaceRecord = {
      ...stored,
      phase,
      ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
    };
    if (phase === "gone") record.gone = stored.gone ?? goneWords(stored.machineId, { by: "record load", at: clock.now(), ...(missing !== undefined ? { answer: missing } : {}) });
    else delete record.gone;
    ctx.attach(record, machine);
    if (phase !== stored.phase) {
      if (phase === "gone") console.warn(goneLogLine(stored.id, record.gone!));
      else console.warn(`workspace ${stored.id} was left ${stored.phase} and its machine is ${String(atProvider)} at the provider; the record hydrates ${phase}`);
      await ctx.persist(record);
    }
    if (phase !== "running" || absent) return undefined;
    if (stored.phase === "napping" || stored.phase === "waking") live.get(stored.id)!.unchecked = true;
    ctx.idle.touch(stored.id);
    return live.get(stored.id)!;
  };

  let hydrated: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    hydrated ??= (async () => {
      const stored = (await store.get(OWNER, "id")) as { id?: unknown } | undefined;
      if (typeof stored?.id === "string" && stored.id !== "") ctx.state.owner = stored.id;
      else {
        ctx.state.owner = `h_${randomBytes(4).toString("hex")}`;
        await store.put(OWNER, "id", { id: ctx.state.owner });
      }
      const since = (await store.get(READS, READS_ID)) as { at?: unknown } | undefined;
      if (typeof since?.at === "number") ctx.state.readsSince = since.at;
      else {
        ctx.state.readsSince = clock.now();
        await store.put(READS, READS_ID, { at: ctx.state.readsSince });
      }
      await ctx.migrateCopies();
      // The places are read before the workspaces: a fork standing on one asks which backend it lives on, and that
      // answer comes off what the place last said about itself rather than off a socket that may not be open.
      await placeDoor?.load();
      // The projects are read before the workspaces: every workspace record names one, and its view joins that
      // project's name, path and computer off this map.
      for (const raw of await store.list(PROJECTS)) {
        const project = raw as ProjectView;
        projectsHeld.set(project.id, project);
      }
      // A project recorded before the repo it sits in was kept on it gets it read once here; a folder git holds no
      // repo in is read again at each boot, which is one git call.
      if (local !== undefined) {
        await Promise.all(
          [...projectsHeld.values()]
            .filter(p => p.git === undefined && p.source.kind === "folder" && copiesFolder(kindForComputer(p.computer)))
            .map(async p => {
              const top = await ctx.gitTopOf(p.path).catch(() => undefined);
              if (top !== undefined) await ctx.rememberProject({ ...p, git: { top } });
            }),
        );
      }
      await setups.load();
      const toSync: LiveWorkspace[] = [];
      const load: LoadReads = { until: clock.now() + LOAD_READS_MS, late: new Map() };
      for (const raw of await store.list(WORKSPACES)) {
        const entry = await hydrateWorkspace(raw, undefined, load);
        if (entry !== undefined) toSync.push(entry);
      }
      // A state file an older build wrote holds the transcripts inside it: each is written to its files whole, and
      // only then is the state file written once without them.
      const inside = (await store.list(TRANSCRIPTS)) as TranscriptRecord[];
      // One whose files did not read stays in the state file, whole, for the next boot to move.
      const moved: string[] = [];
      for (const t of inside) {
        try {
          await ctx.moveTranscript(t);
          moved.push(t.workspaceId);
        } catch (e) {
          console.warn(`${e instanceof Error ? e.message : String(e)}, so it stays in the state file for the next boot to move`);
        }
      }
      await Promise.all(moved.map(id => store.delete(TRANSCRIPTS, id)));
      if (rows !== undefined) ctx.moveBlobs(rows);
      for (const id of await store.keys(WORKSPACES)) if (!transcriptIndex.has(id)) await ctx.loadIndex(id);
      const left: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; run?: string; from?: number; asked?: TurnAsked; turnToken?: string; scopeDeviceId?: string; snapshot?: string; unanswered?: true }[] = [];
      /** Turns that ended while their card was still being read: the commit stayed on the row for this host to read. */
      const unread: { view: SessionView; turnId: string; snapshot?: string }[] = [];
      for (const raw of await store.list(SESSIONS)) {
        const index = raw as SessionIndexRecord;
        if (!live.has(index.workspaceId)) continue;
        const marks = Object.entries(index.viewed ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string");
        if (marks.length > 0) ctx.viewedMarks.set(index.workspaceId, Object.fromEntries(marks));
        for (const [threadId, held] of Object.entries(index.threads ?? {})) {
          if (typeof held?.harness !== "string") continue;
          const placed = ThreadPlacement.safeParse(held.section);
          const ended = TurnStatus.safeParse(held.ended);
          threadRecords.set(threadId, {
            workspaceId: index.workspaceId,
            harness: held.harness,
            ...(typeof held.permissionMode === "string" ? { permissionMode: held.permissionMode } : {}),
            ...(typeof held.parentThreadId === "string" ? { parentThreadId: held.parentThreadId } : {}),
            ...(typeof held.rootThreadId === "string" ? { rootThreadId: held.rootThreadId } : {}),
            ...(typeof held.readAt === "number" ? { readAt: held.readAt } : {}),
            ...(typeof held.settledAt === "number" ? { settledAt: held.settledAt } : {}),
            ...(typeof held.settleNamedAt === "number" ? { settleNamedAt: held.settleNamedAt } : {}),
            ...(typeof held.pinnedAt === "number" ? { pinnedAt: held.pinnedAt } : {}),
            ...(typeof held.foldedAt === "number" ? { foldedAt: held.foldedAt } : {}),
            ...(typeof held.replaces === "string" ? { replaces: held.replaces } : {}),
            ...(typeof held.snoozedUntil === "number" ? { snoozedUntil: held.snoozedUntil } : {}),
            ...(placed.success ? { section: placed.data } : {}),
            ...(typeof held.resumeAt === "string" ? { resumeAt: held.resumeAt } : {}),
            ...(typeof held.limitResume?.at === "number" && typeof held.limitResume.turnId === "string" ? { limitResume: { at: held.limitResume.at, turnId: held.limitResume.turnId } } : {}),
            ...(typeof held.rewound?.before === "string" && typeof held.rewound.at === "number" ? { rewound: { before: held.rewound.before, at: held.rewound.at } } : {}),
            ...(typeof held.worked === "boolean" ? { worked: held.worked } : {}),
            ...(ended.success ? { ended: ended.data } : {}),
          });
          if (typeof held.snoozedUntil === "number") wakeAt(threadId, held.snoozedUntil);
          const armed = threadRecords.get(threadId)?.limitResume;
          if (armed !== undefined) ctx.resumeOnReset(threadId, armed.at);
        }
        if (!Array.isArray(index.sessions)) {
          console.warn(`sessions document for ${index.workspaceId} has no rows array, read as empty`);
          continue;
        }
        for (const { turnId, notify, notifyBy, notifyRoad, reply, told, toldLast: _toldLast, steered: storedSteered, run, from, asked: storedAsked, turnToken, scopeDeviceId, snapshot, ...view } of index.sessions) {
          const by = readScope(notifyBy);
          const asked = readAsked(storedAsked);
          const road = readRoad(notifyRoad);
          const steered = readSteered(storedSteered);
          const row: {
            view: SessionView;
            turnId: string;
            notify?: readonly string[];
            notifyBy?: ThreadScope;
            notifyRoad?: WorkspaceOrigin;
            turnLive?: TurnLive;
            run?: string;
            from?: number;
            asked?: TurnAsked;
            turnToken?: string;
            scopeDeviceId?: string;
            snapshot?: string;
            end?: (reason: string, stopped?: boolean, unreached?: boolean) => void;
          } = {
            view,
            turnId,
            // A state file written before a row held several targets carries the one it had as a bare string; the
            // document is read back unchecked, so the shape is settled here rather than in every reader of it.
            ...(notify !== undefined ? { notify: typeof notify === "string" ? [notify] : notify } : {}),
            // A document written before the scope rode beside the targets carries none, and its lines go as they
            // went then, as the person's; one that does not read as a scope is no scope at all.
            ...(by !== undefined ? { notifyBy: by } : {}),
            ...(road !== undefined ? { notifyRoad: road } : {}),
            ...(reply !== undefined || typeof told === "number" || steered !== undefined
              ? { turnLive: { ...(reply !== undefined ? { reply } : {}), ...(typeof told === "number" ? { told } : {}), ...(steered !== undefined ? { steered } : {}) } }
              : {}),
            ...(run !== undefined ? { run } : {}),
            ...(typeof from === "number" && Number.isSafeInteger(from) && from >= 0 ? { from } : {}),
            ...(asked !== undefined ? { asked } : {}),
            ...(turnToken !== undefined ? { turnToken } : {}),
            ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}),
            ...(snapshot !== undefined ? { snapshot } : {}),
          };
          // A row left running because nothing answered about its run has no harness of its own to end, and the poll
          // that finds its machine gone must still be able to settle it.
          row.end = (reason, stopped, unreached) => {
            if (row.view.status !== "running") return;
            ctx.settleCut(row, reason, () => reason, stopped, unreached);
            void ctx.persistSessions(row.view.workspaceId);
          };
          if (view.status === "running") left.push(row);
          else if (row.snapshot !== undefined) unread.push(row);
          sessions.set(view.id, row);
        }
      }
      // Each record the load held while its read was out, loaded once the read lands; whatever the load does with
      // such a record's entry waits for this first.
      const landing = new Map([...load.late].map(([id, read]) => [id, loadLate(id, read)]));
      for (const row of unread) {
        const { workspaceId, threadId, cwd, claudeSessionId, id, startedAt } = row.view;
        const from = row.snapshot!;
        void (async () => {
          await landing.get(workspaceId);
          const entry = live.get(workspaceId)!;
          const read =
            threadId === undefined ||
            cwd === undefined ||
            turnWritten(await ctx.openTranscript(workspaceId), row.turnId).changes ||
            (await ctx.readTurnChanges(entry, { sessionId: claudeSessionId ?? id, turnId: row.turnId, threadId, cwd, from, startedAt: startedAt ?? Date.now() }));
          delete row.snapshot;
          if (read || !ctx.state.closing) await ctx.persistSessions(workspaceId);
        })().catch((e: unknown) => console.warn(`what ${row.turnId} changed was not read: ${e instanceof Error ? e.message : String(e)}`));
      }
      void Promise.all([...live.keys()].map(id => rereadHeld(id, "record load").catch((e: unknown) => console.warn(`workspace ${id} was not read again: ${e instanceof Error ? e.message : String(e)}`))));
      // A turn's run belongs to the machine it runs on, not to the host that asked for it, so a host that comes back
      // re-opens every run the machines still hold and reads the rest of its output. Only the machine's own answer
      // that a run is gone ends that turn, and a machine that answered nothing leaves its turn running. The ends are
      // told once every workspace's rows are in: the parent a settled turn tells may sit in a workspace read after
      // its own, and a re-opened turn's own end tells it later, when it ends.
      const reopen = async (rows: readonly (typeof left)[number][], again = false): Promise<void> => {
        // A stop meeting a re-open still out would race the run it reads: the mark stands only between rounds.
        for (const row of rows) delete row.unanswered;
        const answers = await Promise.all(rows.map(async s => ({ row: s, answer: await ctx.reattach(s, again) })));
        const cut = new Set<string>();
        for (const { row, answer } of answers) {
          if (answer === "cannot") ctx.settleCut(row, RESTARTED_REASON, endedAt => restartCutLine(endedAt - (row.view.startedAt ?? endedAt)));
          else if (answer === "gone") ctx.settleCut(row, RUN_GONE_LINE, () => RUN_GONE_LINE);
          if ((answer === "cannot" || answer === "gone") && row.view.threadId !== undefined) cut.add(row.view.threadId);
        }
        // A row still unanswered changed nothing, so a round that answered nothing writes nothing.
        for (const workspaceId of new Set(answers.filter(a => a.answer !== "unreached").map(a => a.row.view.workspaceId))) void ctx.persistSessions(workspaceId);
        const unanswered = answers.filter(a => a.answer === "unreached").map(a => a.row);
        for (const row of unanswered) row.unanswered = true;
        if (unanswered.length > 0) askAgain(unanswered);
        // The token of a turn cut here dies with it, as the boot's own pass below takes the tokens of turns not running.
        if (cut.size === 0) return;
        for (const device of await deviceDoor.list()) {
          const thread = device.scope?.threadId;
          if (thread !== undefined && cut.has(thread) && !ctx.threadRuns(thread)) await deviceDoor.revoke(device.id);
        }
      };
      /** A run its machine said nothing about is asked after again a link window on, for as long as its row runs here:
       * nothing else reads its end, a stop cannot reach it, and the idle nap waits on that row. */
      const askAgain = (rows: readonly (typeof left)[number][]): void => {
        clock.schedule(
          () => {
            if (ctx.state.closing) return;
            const still = rows.filter(s => sessions.get(s.view.id) === s && s.view.status === "running");
            const ready = still.filter(s => live.get(s.view.workspaceId)?.record.phase === "running");
            if (ready.length < still.length) askAgain(still.filter(s => !ready.includes(s)));
            if (ready.length > 0) void reopen(ready, true).catch((e: unknown) => console.warn(`the turns left running were not asked after again: ${e instanceof Error ? e.message : String(e)}`));
          },
          LINK_RETRY_WINDOW_MS,
          { unref: true },
        );
      };
      // Each machine's turns are re-opened and then its runs swept in the background, and only what starts a run on
      // that machine waits for it, since a machine still restoring answers nothing for minutes. The sweep ends every
      // run left over from a host that never came back to read it, whose harness holds the machine's memory for its
      // life, and every run started there while its listing was out. The daemon sync waits out a running turn, so it
      // starts once the rows the machine no longer holds are settled.
      for (const held of live.values()) {
        const id = held.record.id;
        const late = landing.get(id);
        const work = (async () => {
          const landed = await late;
          const entry = late === undefined ? held : (landed ?? live.get(id));
          if (entry === undefined) return;
          // A worktree's dependency mounts went with a restart of this computer.
          if (entry.record.worktree?.made === true) await ctx.worktreeMounted(entry);
          await reopen(left.filter(s => s.view.workspaceId === id));
          await ctx.sweepRuns(entry);
          if (late === undefined ? toSync.includes(entry) : landed !== undefined) void ctx.syncDaemon(entry);
        })();
        ctx.bootWork.set(id, work.catch((e: unknown) => console.warn(`the turns and runs on ${id} were not settled: ${e instanceof Error ? e.message : String(e)}`)).finally(() => ctx.bootWork.delete(id)));
      }
      // A start a computer's threads at once held back lived in the old host's memory alone, so each ends here with the
      // restart named: a follower reads its end off the transcript, and the thread it was to report to is told.
      for (const raw of await store.list(HELD_STARTS)) {
        const h = raw as HeldStartRecord;
        await store.delete(HELD_STARTS, h.turnId);
        if (!live.has(h.workspaceId)) continue;
        const reason = capRestartedLine(h.place);
        const view: SessionView = { id: h.turnId, workspaceId: h.workspaceId, harness: h.harness, status: "failed", threadId: h.threadId, ...(h.sessionId !== h.turnId ? { claudeSessionId: h.sessionId } : {}) };
        const notifyBy = readScope(h.notifyBy);
        const notifyRoad = readRoad(h.notifyRoad);
        if (h.notify !== undefined) ctx.notifyEnd({ view, turnId: h.turnId }, h.notify, ctx.tellAs({ ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}) }), { status: "failed", error: reason });
        ctx.record({ type: "session.end", workspaceId: h.workspaceId, sessionId: h.sessionId, turnId: h.turnId, threadId: h.threadId, exitCode: null, sawResult: false, reason, unstarted: true, ...(h.prompt !== undefined ? { prompt: h.prompt } : {}) });
      }
      // A turn's token dies with the turn, and a host that went down under one never reached that exit: every scoped
      // device whose thread is not running now is taken away here, so a restart is not how a token outlives its turn.
      for (const device of await deviceDoor.list()) {
        const thread = device.scope?.threadId;
        if (thread !== undefined && !ctx.threadRuns(thread)) await deviceDoor.revoke(device.id);
      }
      await deviceDoor.revokeAsides();
      // Each start waits for its thread's workspace to settle its turns, so a line meets the turn re-opened there.
      void ctx.deliverOwed().catch((e: unknown) => console.warn(`the lines owed to threads were not sent: ${e instanceof Error ? e.message : String(e)}`));
      // Each builder is read beside the others, and the load waits for them no later than its one deadline: one still
      // out is admitted when its read lands, and a refresh before that waits on the same read.
      const admitted = Promise.all(
        ((await store.list(BUILDERS)) as StoredBuilder[]).map(b =>
          admitOnce(b).catch((e: unknown) => console.warn(`builder ${b.id} was not read, so the next look at the builders reads it again: ${e instanceof Error ? e.message : String(e)}`)),
        ),
      );
      await new Promise<void>(resolve => {
        const cancel = clock.schedule(resolve, Math.max(0, load.until - clock.now()), { unref: true });
        void admitted.then(() => (cancel(), resolve()));
      });
      // Not waited on: a fetch of a big copy's branches takes seconds, and the records it drops leave as they go.
      ctx.state.copiesMoving = ctx.moveOldCopies().catch((e: unknown) => console.warn(`the move off old copies stopped: ${e instanceof Error ? e.message : String(e)}`));
      ctx.armSweep();
      // A run that was running when the host stopped is failed and its done fires once, at start (02, "Host restart").
      void ctx.slates.ready().catch((e: unknown) => console.warn(`the slates were not loaded: ${e instanceof Error ? e.message : String(e)}`));
    })();
    return hydrated;
  };

  /** Every verb that names a workspace comes through here, so the origin rule is read once for all of them. A verb
   * may start a run on the machine, so it waits for what the boot still has out there; `now` is for a read that
   * walks every workspace, which no one machine may hold, and `act` is what the verb asks there, as a refusal names it. */
  const entryOf = async (id: string, origin?: Caller, o: { now?: true; act?: AcrossAct; thread?: string } = {}): Promise<LiveWorkspace> => {
    await ready();
    const entry = live.get(id);
    // A workspace this host does not hold and one outside the caller's tree read alike to a thread: telling the two
    // apart is how a thread walks what else stands here.
    if (!entry || entry.creating) throw notFoundRefusal(scopeOf(origin) !== undefined ? noWorkspaceRefusal() : `${noWorkspaceRefusal()}: ${id}`);
    // A thread named here words a refusal only where it is of the caller's tree and on this record, which it knows.
    const thread = o.thread !== undefined && ctx.threadRecords.get(o.thread)?.workspaceId === id && ctx.drivesThread(o.thread, origin) ? o.thread : undefined;
    ctx.refuseRelayed(entry.record, origin, o.act, thread);
    if (o.now === true) return entry;
    await ctx.bootWork.get(id);
    // The boot work loads a record the load held while its machine's read was out, onto an entry of its own.
    return live.get(id) ?? entry;
  };
  /** A lead's child named by id or by name, refused for a workspace that is not that lead's child. */
  const childOf = async (lead: LiveWorkspace, ref: string, origin?: Caller, threads: { lead?: string; child?: string } = {}): Promise<LiveWorkspace> => {
    const named = await ctx.workspaces.resolve(ref, origin);
    const kid = await entryOf(named.id, origin, threads.child === undefined ? {} : { thread: threads.child });
    if (kid.record.parentWorkspaceId !== lead.record.id) throw Object.assign(new Error(notTheLeadsChildRefusal(labelOf(kid, threads.child), labelOf(lead, threads.lead))), { kind: "invalid" });
    return kid;
  };
  /** Which rows a caller reaches, for the verbs that name a thread rather than a workspace: the thread tree, then
   * the kind rule and the computer rule on the row's workspace, so a request relayed from a machine still drives only
   * kinds that take one, and a thread on a box acts on that box's threads alone. A thread on a computer the person
   * joined reaches its own tree's threads wherever they run for `talk` alone, a message into one or the listing of
   * them, and nothing of their turns beyond that.
   * Neither the project rule nor the workspace tree is read here: a child on a fresh copy reaches its lead on the
   * workspace the person made, which the workspace rule alone would hide from it. */
  const reachesRow = (row: { threadId?: string; workspaceId: string }, caller: Caller | undefined, talk?: TreeTalk): boolean => {
    if (!ctx.drivesThread(row.threadId, caller)) return false;
    const record = live.get(row.workspaceId)?.record;
    return record === undefined || (talk !== undefined && ctx.talksToItsTree(caller)) || ctx.actsOn(record, caller);
  };
  /** Every session verb that names a thread comes through here, as the verbs naming a workspace come through
   * entryOf: the entry the row stands on, or nothing when the caller is a thread the row is out of reach for, so
   * the verb answers absence and no sentence says which rule hid the row. A caller that is no thread reads the
   * workspace as every verb naming one does. */
  const entryOfRow = async (row: { threadId?: string; workspaceId: string }, origin: Caller | undefined, talk?: TreeTalk): Promise<LiveWorkspace | undefined> => {
    if (scopeOf(origin) === undefined) return entryOf(row.workspaceId, origin);
    await ready();
    const entry = live.get(row.workspaceId);
    if (entry === undefined || entry.creating || !reachesRow(row, origin, talk)) return undefined;
    await ctx.bootWork.get(row.workspaceId);
    return live.get(row.workspaceId) ?? entry;
  };
  /** Rows as a listing answers them: each with the stamps and marks its thread's record keeps, and with what only a
   * live turn knows, which rides the answer and never the row. */
  const listedRows = (held: readonly (typeof sessions extends Map<string, infer V> ? V : never)[]): SessionView[] => {
    // A thread's subagents ride its latest row alone, the one foldThreads reads, so a thread of several rows lists
    // each child once.
    const latest = new Map(held.map(s => [threadKeyOf(s.view), s] as const));
    const replacedBy = ctx.restarts();
    // The turn's process and what its calls are stopped behind ride the answer and never the row itself: both are
    // this host's to know while the turn runs, and a pid written down outlives the process it named while a wait
    // written down outlives the question it was on.
    return held.map(s => {
      const behind = s.view.status === "running" ? ctx.stoppedBehind(s) : undefined;
      const capped = ctx.capHeld.get(s.turnId)?.waiting?.wait;
      const marks = threadRecords.get(threadKeyOf(s.view));
      const restart = replacedBy.get(threadKeyOf(s.view));
      // A restart names the thread it replaced while that thread stands; once it is deleted there is nothing to open.
      const replaces = marks?.replaces ?? s.replaces;
      const children = latest.get(threadKeyOf(s.view)) === s && s.view.threadId !== undefined ? transcriptIndex.get(s.view.workspaceId)?.children.get(s.view.threadId) : undefined;
      return {
        ...s.view,
        ...(s.view.status === "running" && s.pid !== undefined ? { pid: s.pid } : {}),
        ...(behind !== undefined ? { waitingOn: behind } : {}),
        ...(capped !== undefined ? { capped } : {}),
        ...(children !== undefined && children.size > 0 ? { subagents: [...children.values()].map(({ turnId: _turn, startRow: _row, ...child }) => child) } : {}),
        ...((): { setupRefusal?: string } => {
          const entry = live.get(s.view.workspaceId);
          const place = entry === undefined ? undefined : ctx.setupPlace(entry);
          const refused = place === undefined ? undefined : ctx.setupRefusals.get(keyOf(place, s.view.harness));
          return refused !== undefined ? { setupRefusal: refused } : {};
        })(),
        // A turn that ended before the stamps began reads as seen the moment it ended, not at the upgrade, so the quiet
        // the sidebar folds a thread by still counts from its end.
        readAt: marks?.readAt ?? (s.view.endedAt !== undefined && s.view.endedAt < ctx.state.readsSince ? s.view.endedAt : ctx.state.readsSince),
        ...(marks?.settledAt !== undefined ? { settledAt: marks.settledAt } : {}),
        ...(marks?.pinnedAt !== undefined ? { pinnedAt: marks.pinnedAt } : {}),
        ...(marks?.foldedAt !== undefined ? { foldedAt: marks.foldedAt } : {}),
        ...(replaces !== undefined && (threadRecords.has(replaces) || ctx.latestOn(replaces) !== undefined) ? { replaces } : {}),
        ...(restart !== undefined ? { replacedBy: restart } : {}),
        ...(marks?.snoozedUntil === undefined ? {} : marks.snoozedUntil > clock.now() ? { snoozedUntil: marks.snoozedUntil } : { wokeAt: marks.snoozedUntil }),
        ...(marks?.section !== undefined ? { section: marks.section } : {}),
        ...(marks?.rewound !== undefined ? { rewoundAt: marks.rewound.at } : {}),
        ...(marks?.limitResume !== undefined && marks.limitResume.turnId === s.turnId ? { resumeAt: marks.limitResume.at } : {}),
      };
    });
  };
  /** A thread's facts off its rows here, as a listing folds them; undefined where the host holds no row of it. */
  const threadFacts = (threadId: string): ThreadFacts | undefined => {
    const held = [...sessions.values()].filter(s => threadKeyOf(s.view) === threadId);
    const [listed] = foldThreads(listedRows(held));
    if (listed === undefined) return undefined;
    const { subagents: _subagents, ...thread } = listed;
    const latest = held.at(-1)!.view;
    const running = held.filter(s => s.view.status === "running").at(-1);
    return {
      ...thread,
      ...(latest.model !== undefined ? { model: latest.model } : {}),
      ...(latest.effort !== undefined ? { effort: latest.effort } : {}),
      ...(latest.contextWindow !== undefined ? { contextWindow: latest.contextWindow } : {}),
      ...(running !== undefined ? { turnId: running.turnId } : {}),
    };
  };
  /** Whether a thread reads settled now, by hand or by quiet time, off the facts its listing carries: the host's one
   * read of it. A thread with no row here reads settled only by its stamp. */
  const settledNow = (threadId: string, settleMs: number | null): boolean => {
    const t = threadFacts(threadId);
    if (t === undefined) return threadRecords.get(threadId)?.settledAt !== undefined;
    const facts = { working: t.status === "running", asking: t.asking !== undefined || t.waitingOn !== undefined, failed: t.status === "failed", startedAt: t.startedAt ?? null, endedAt: t.endedAt ?? null, readAt: t.readAt ?? null, settledAt: t.settledAt ?? null };
    return threadSettled(facts, clock.now(), settleMs);
  };
  /** Tells every window a thread's facts moved, so none asks for its head again. */
  const pushHead = (threadId: string): void => {
    const facts = threadFacts(threadId);
    if (facts !== undefined) bus.emit({ type: "thread.head", workspaceId: facts.workspaceId, threadId, facts, pos: transcriptIndex.get(facts.workspaceId)?.pos ?? 0 });
  };
  /** Rows with the project and the computer their workspace stands on, as every listing and every pushed row has them. */
  const placedRows = async (listed: SessionView[]): Promise<SessionView[]> => {
    const computers = listed.length === 0 ? [] : await computerRows();
    return listed.map(view => {
      const id = live.get(view.workspaceId)?.record.project;
      const project = id === undefined ? undefined : projectsHeld.get(id);
      const computer = computers.find(r => r.id === project?.computer);
      return project === undefined ? view : { ...view, project: { id: project.id, name: project.name }, computerName: computer === undefined ? project.computer : tableName(computer) };
    });
  };
  /** The row ids pushed once already, whose opening prompt (a builder's brief of kilobytes, repeated on every row of
   * its thread) the next push leaves out, and the turns told while stopped behind another thread's prompt. A launch
   * moves its row from the turn's id to the harness's, so the first push under the new id carries the prompt again. */
  const toldRows = new Set<string>();
  const toldBehind = new Set<string>();
  /** The threads whose latest row moved in this tick, and the row ids the host stopped holding: each goes out once,
   * after the event that moved it is out, since a push inside that event's own emit would reach a socket before it.
   * Into no replay ring: a socket that comes back reads every row again, and the ring kept them at 1.8 MB a day. A
   * batch that fails goes out with the next one. */
  const rowsMoved = new Map<string, string>();
  const rowsGone = new Map<string, { workspaceId: string; threadId?: string }>();
  let rowsQueued = false;
  let rowsOut = Promise.resolve();
  const pushRows = (): void => {
    rowsQueued = false;
    const moved = [...rowsMoved];
    const gone = [...rowsGone].filter(([id]) => !sessions.has(id));
    rowsMoved.clear();
    rowsGone.clear();
    const told: string[] = [];
    const rows = moved.flatMap(([threadId]) => {
      const held = [...sessions.values()].filter(s => threadKeyOf(s.view) === threadId);
      const latest = held.at(-1);
      if (latest === undefined) return [];
      const view = listedRows(held).at(-1)!;
      const { prompt: _told, ...rest } = view;
      told.push(view.id);
      if (view.waitingOn !== undefined) toldBehind.add(latest.turnId);
      else toldBehind.delete(latest.turnId);
      return [toldRows.has(view.id) ? rest : view];
    });
    // A rename made inside the harness reaches this host only when it asks, which a listing did on every event: the
    // rows of each workspace that moved are asked now, each at most once a title's TTL.
    for (const workspaceId of new Set(moved.map(([, at]) => at))) {
      if (ctx.bootWork.has(workspaceId)) continue;
      for (const view of ctx.titleRows([...sessions.values()].flatMap(s => (s.view.workspaceId === workspaceId ? [s.view] : [])))) void ctx.refreshTitle(view, false);
    }
    rowsOut = rowsOut.then(async () => {
      for (const [id, at] of gone) bus.pass({ type: "session.row", ...at, id });
      for (const row of await placedRows(rows)) bus.pass({ type: "session.row", workspaceId: row.workspaceId, ...(row.threadId !== undefined ? { threadId: row.threadId } : {}), id: row.id, row });
      for (const id of told) toldRows.add(id);
      for (const [id] of gone) toldRows.delete(id);
      if (toldRows.size > 2 * sessions.size + 64) for (const id of toldRows) if (!sessions.has(id)) toldRows.delete(id);
    }).catch((e: unknown) => {
      console.warn(`a moved row was not pushed: ${e instanceof Error ? e.message : String(e)}`);
      for (const [threadId, workspaceId] of moved) if (!rowsMoved.has(threadId)) rowsMoved.set(threadId, workspaceId);
    });
  };
  const queueRows = (): void => {
    if (rowsQueued) return;
    rowsQueued = true;
    queueMicrotask(pushRows);
  };
  const rowMoved = (workspaceId: string, threadId: string): void => {
    queueRows();
    rowsMoved.set(threadId, workspaceId);
  };
  /** A row the host held under this id no longer stands: every window drops it, once the host holds nothing there. */
  const rowGone = (id: string, at: { workspaceId: string; threadId?: string }): void => {
    queueRows();
    rowsGone.set(id, { workspaceId: at.workspaceId, ...(at.threadId !== undefined ? { threadId: at.threadId } : {}) });
  };
  /** An agent's setup on a computer was refused or cleared: every thread of that agent there carries the word. */
  const setupRefusalMoved = (place: string, harness: string): void => {
    for (const s of sessions.values()) {
      const entry = live.get(s.view.workspaceId);
      if (s.view.harness === harness && entry !== undefined && ctx.setupPlace(entry) === place) rowMoved(s.view.workspaceId, threadKeyOf(s.view));
    }
  };
  bus.on("*", e => {
    switch (e.type) {
      case "thread.head":
        // A row stopped behind this thread carries its title.
        rowMoved(e.workspaceId, e.threadId);
        for (const s of sessions.values()) {
          if (toldBehind.has(s.turnId) && ctx.stoppedBehind(s)?.threadId === e.threadId) rowMoved(s.view.workspaceId, threadKeyOf(s.view));
        }
        return;
      case "session.held":
      case "session.capped":
      case "session.subagent":
        if (e.threadId !== undefined) rowMoved(e.workspaceId, e.threadId);
        return;
      case "thread.marked":
        for (const threadId of e.threadIds) rowMoved(e.workspaceId, threadId);
        return;
      case "session.start":
        // The row held under the turn's id while it reached the machine is now under the harness's.
        if (e.turnId !== undefined && e.turnId !== e.sessionId) rowGone(e.turnId, e);
        return;
      case "session.end":
        if (e.turnId !== undefined && ![...sessions.values()].some(s => s.turnId === e.turnId)) rowGone(e.sessionId, e);
        return;
      case "session.permission":
      case "session.permission.closed":
        // A prompt moves its own row and every row stopped behind it, which can be on any workspace.
        if (e.threadId !== undefined) rowMoved(e.workspaceId, e.threadId);
        for (const s of sessions.values()) {
          if (s.view.status === "running" && (toldBehind.has(s.turnId) || ctx.stoppedBehind(s) !== undefined)) rowMoved(s.view.workspaceId, threadKeyOf(s.view));
        }
        return;
      case "session.delta":
        // A call that follows other threads may stop this row behind a prompt one of them has open, and its result
        // moves it back.
        if (e.threadId === undefined) return;
        if (e.kind === "tool_use" ? e.toolName !== undefined && threadsFollowed({ toolName: e.toolName, input: e.text }) !== undefined : e.kind === "tool_result" && e.turnId !== undefined && toldBehind.has(e.turnId)) rowMoved(e.workspaceId, e.threadId);
        return;
    }
  });
  /** Moves the read or settled stamp of each thread, by fold key, on the thread's record, which a thread from before
   * records existed takes here off its latest row; each workspace touched is written once and told once. Every
   * thread is checked before any moves, so a list naming one the caller cannot reach moves nothing. */
  const mark = async (threadIds: readonly string[], stamped: ThreadStamps | ((threadId: string) => ThreadStamps), origin: Caller | undefined): Promise<void> => {
    await ready();
    const found = await Promise.all(
      threadIds.map(async threadId => {
        const latest = [...sessions.values()].filter(s => threadKeyOf(s.view) === threadId).at(-1)?.view;
        const record = threadRecords.get(threadId);
        const workspaceId = latest?.workspaceId ?? record?.workspaceId;
        if (workspaceId === undefined || (await entryOfRow({ ...(latest?.threadId !== undefined ? { threadId: latest.threadId } : { threadId }), workspaceId }, origin)) === undefined) {
          throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
        }
        return { threadId, workspaceId, base: record ?? { workspaceId, harness: latest!.harness } };
      }),
    );
    const touched = new Map<string, string[]>();
    for (const { threadId, workspaceId, base } of found) {
      const stamps = typeof stamped === "function" ? stamped(threadId) : stamped;
      const next: ThreadRecord & { workspaceId: string } = { ...base, ...stamps };
      for (const key of Object.keys(stamps) as (keyof typeof stamps)[]) if (stamps[key] === undefined) delete next[key];
      threadRecords.set(threadId, next);
      // A thread the person settled is done with: its kept agent goes now rather than at the end of the keep.
      if (next.settledAt !== undefined) ctx.reapKept(threadId);
      if (next.snoozedUntil !== undefined) wakeAt(threadId, next.snoozedUntil);
      if ("limitResume" in stamps) {
        if (next.limitResume !== undefined) ctx.resumeOnReset(threadId, next.limitResume.at);
        else ctx.resumeTimers.get(threadId)?.();
      }
      touched.set(workspaceId, [...(touched.get(workspaceId) ?? []), threadId]);
    }
    for (const [workspaceId, ids] of touched) {
      await ctx.persistSessions(workspaceId);
      bus.emit({ type: "thread.marked", workspaceId, threadIds: ids });
    }
  };
  /** A thread that asks for the person or fails ends the snooze standing on its tree, its own or its root's, as a
   * snooze that ran out does: the thread reads as woken now and every window hears it. A turn that finished does not,
   * or a busy tree could never stay snoozed. */
  const endSnoozeFor = (row: Pick<SessionView, "threadId" | "rootThreadId">): void => {
    const now = clock.now();
    const standing = [...new Set([row.threadId, row.rootThreadId])].filter((id): id is string => id !== undefined && (threadRecords.get(id)?.snoozedUntil ?? 0) > now);
    if (standing.length > 0) void mark(standing, { snoozedUntil: now }, undefined).catch((e: unknown) => console.warn(`snooze not ended for ${standing.join(", ")}: ${e instanceof Error ? e.message : String(e)}`));
  };
  /** Arms Resume at reset on each thread, at the reset its latest turn's usage limit named, or cancels it. Every
   * thread is read before any moves, so one the caller cannot reach or with no such reset arms nothing. */
  const armResume = async (threadIds: readonly string[], on: boolean, origin: Caller | undefined): Promise<void> => {
    if (!on) return mark(threadIds, { limitResume: undefined }, origin);
    await ready();
    const arms = await Promise.all(
      threadIds.map(async threadId => {
        const latest = [...sessions.values()].filter(s => threadKeyOf(s.view) === threadId).at(-1);
        if (latest === undefined || (await entryOfRow(latest.view, origin)) === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
        const at = latest.view.limit?.resetsAt;
        if (at === undefined) throw refusal(`thread ${threadWord(threadId)} is not stopped at a usage limit with a known reset,`, "so there is nothing to resume at; send it a message to go on now.", "usage");
        return { threadId, arm: { at, turnId: latest.turnId } };
      }),
    );
    for (const { threadId, arm } of arms) await mark([threadId], { limitResume: arm }, origin);
  };
  /** Resume at reset, come due: the stopped turn goes on unless by now the thread was taken away or settled, a newer
   * turn ran on it, something on it waits on the person, or its plan's latest reading still holds the agent past the
   * reset, in which case the row takes the new reset and nothing is sent. The arm goes either way. Never a banked
   * reset: the turn waits out the plan's own window. */
  const resumeAfterLimit = async (threadId: string): Promise<void> => {
    await ready();
    const record = threadRecords.get(threadId);
    const arm = record?.limitResume;
    if (record === undefined || arm === undefined) return;
    const latest = [...sessions.values()].filter(s => threadKeyOf(s.view) === threadId).at(-1);
    const entry = live.get(record.workspaceId);
    const stands = record.settledAt === undefined && entry !== undefined && latest !== undefined && latest.turnId === arm.turnId && latest.view.limit !== undefined;
    const facts = stands ? threadFacts(threadId) : undefined;
    const waits = ctx.leadAsks.has(threadId) || facts?.asking !== undefined || facts?.waitingOn !== undefined;
    const held = stands && !waits ? await heldPast(entry!, latest!.view.harness) : undefined;
    // Dropped only now, so a host that stops inside the reads above still holds the arm and runs this again at load;
    // an arm cancelled or moved meanwhile is no longer this one's to act on.
    const current = threadRecords.get(threadId);
    if (current?.limitResume !== arm) return;
    delete current.limitResume;
    if (held !== undefined) latest!.view.limit = { resetsAt: held };
    await ctx.persistSessions(record.workspaceId);
    bus.emit({ type: "thread.marked", workspaceId: record.workspaceId, threadIds: [threadId] });
    if (!stands || waits || held !== undefined) return;
    await ctx.sessionsApi.start(record.workspaceId, { prompt: LIMIT_RESUME_PROMPT, thread: threadId, afterLimit: arm.at });
  };
  /** The reset the latest reading of an agent's account on that workspace's computer still holds it behind, now;
   * undefined where nothing holds it or no reading says. */
  const heldPast = async (entry: LiveWorkspace, harness: string): Promise<number | undefined> => {
    const limits = await ctx.ledger.limits().catch(() => []);
    const vaulted = ctx.vaultedFor(harness, ctx.moduleOf(entry.record.kind).loginStands(entry, harness), ctx.vaultOn(entry));
    const { key } = accountOnComputer({ agent: harness, agentName: harnessCatalog(harness)?.label ?? harness, computer: { id: ctx.usageComputerOf(entry.record), name: ctx.computerOf(entry) }, limits, vaulted });
    return heldUntil(limits.find(l => l.key === key)?.windows ?? [], clock.now());
  };
  /** The threads of the caller's tree by their records, which the cap on a workspace's rows never trims, on one
   * workspace or on every one this host holds. A record names its root, read before the row rule, so a host of many
   * threads walks no rows for each record outside the tree. */
  const treeRecords = (caller: Caller | undefined, talk: TreeTalk | undefined, workspaceId?: string): [string, ThreadRecord & { workspaceId: string }][] => {
    const root = scopeOf(caller)?.rootThreadId;
    if (root === undefined) return [];
    return [...threadRecords].filter(([threadId, r]) => (r.rootThreadId ?? threadId) === root && (workspaceId ?? r.workspaceId) === r.workspaceId && live.has(r.workspaceId) && reachesRow({ threadId, workspaceId: r.workspaceId }, caller, talk));
  };
  /** Whether a thread of the caller's tree stands on that workspace, by a row or by a record whose rows the cap took,
   * which is what lets a child list and read the transcript of the workspace its lead runs on; a caller that is no
   * thread reads workspaces by their own rule. */
  const treeStandsOn = (workspaceId: string, caller: Caller | undefined, talk?: TreeTalk): boolean =>
    scopeOf(caller) !== undefined && ([...sessions.values()].some(s => s.view.workspaceId === workspaceId && reachesRow(s.view, caller, talk)) || treeRecords(caller, talk, workspaceId).length > 0);
  /** Whether a thread on a computer the person joined names, by its id, a workspace a thread of its own tree stands
   * on: what a message to its lead on this computer reads on the way, the workspace's agents and its state. A thread
   * on a machine reaches its tree by the thread alone. */
  const talksToTreeOn = (workspaceId: string, caller: Caller | undefined): boolean => ctx.talksToItsTree(caller) && treeStandsOn(workspaceId, caller, "send");

  /** The create itself, one stage report per awaited step. The hostname is set inside the fork, before the daemon
   * is asked and before the workspace is listed or reachable, so no shell can open under the guest's boot name. */
  /** Where a fork lands: the word the person typed, else the place a fork last landed on. This host's own provider is
   * a place with no id, which is what every fork before joined computers existed stood on. */
  /** The computers a project can live on, by the row each carries in the places table: this computer, the ones
   * joined to it and the providers. A host wired without places holds the two it has anyway, so a project can be
   * recorded before anybody joins a computer. */
  const computerRows = async (): Promise<{ id: string; name: string; kind: PlaceKind }[]> => {
    const rows = placeDoor === undefined ? [{ id: HERE_PLACE_ID, name: hostname(), kind: "computer" as const }] : (await placeDoor.rows()).map(p => ({ id: p.id, name: p.name, kind: p.kind }));
    // The provider this host forks on is a computer a project can live on whether or not the places table lists it:
    // a host wired without places holds no table at all, and one whose door has not heard of its provider yet
    // still forks there.
    return rows.some(r => r.id === places.wired) ? rows : [...rows, { id: places.wired, name: places.wired, kind: "provider" as const }];
  };

  /** What a sentence calls a computer: the name its row carries, the id where this host holds no row for it. */
  const nameOfComputer = (computer: string, rows: readonly { id: string; name: string }[]): string => rows.find(r => r.id === computer)?.name ?? computer;

  /** The image a workspace forks when nobody named a project image: the head of this host's own, or nothing where
   * this host has sealed none yet. */
  const imageHeadOrNone = async (): Promise<string | undefined> => goldenHead(await ctx.copyOf(await ctx.imagePlace("default"), "default"))?.snapshotId;

  /** The same, for every road that cannot go on without one. */
  const imageHead = async (): Promise<string> => {
    const head = await imageHeadOrNone();
    if (head === undefined) throw new Error(NO_IMAGE_YET);
    return head;
  };

  /** Where a workspace of a project lands, as a place: this computer and the provider this host forks on carry no
   * place id, and every other computer is the place it is. */
  const landingPlace = async (computer: string): Promise<{ placeId?: string }> => {
    const lands = workspaceLands(computer, places.wired);
    return lands.at === "place" ? ctx.placeDoorOf().placeFor(lands.place) : {};
  };
  return {
    refreshBuilders, isHeldAway, rereadHeld, hydrateWorkspace, ready, entryOf, childOf, reachesRow, entryOfRow,
    listedRows, placedRows, rowGone, setupRefusalMoved, threadFacts, settledNow, pushHead, mark, endSnoozeFor, armResume, resumeAfterLimit, treeRecords, treeStandsOn, talksToTreeOn, computerRows, nameOfComputer, imageHeadOrNone,
    imageHead, landingPlace,
  };
}
