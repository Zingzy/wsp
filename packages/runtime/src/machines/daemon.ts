// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { landsBytes } from "@wsp/engine";
import { type ReachState, type Caller, type WorkspaceStatus, threadWord, DAEMON_INSTALL_FAILED, DAEMON_INSTALLING, DAEMON_RESTART_FAILED, DAEMON_RESTARTING, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, machineLacksLine, machineNeverAnswered, runsInFolder } from "@wsp/protocol";
import { type LiveWorkspace, DAEMON_REVIVE_AGAIN_MS, DAEMON_LACKS_AGAIN_MS } from "../types/wiring.js";
import type { MachineMoment } from "../types/internal.js";
import type { RuntimeContext, DaemonArea } from "../context.js";

export function daemonArea(ctx: RuntimeContext): DaemonArea {
  const { bus, clock, daemonHelloTimeoutMs, live, sessions } = ctx;
  /** A message into a thread, or a thread opened with it, answered as soon as it is on its way, as `wsp send --detach`
   * does: joined into the running turn, waiting behind it, or started. The turn goes on without the caller. */
  const sendDetached = async (
    workspaceId: string,
    o: { prompt: string; thread?: string },
    origin: Caller | undefined,
  ): Promise<{ outcome: "steered" | "queued" | "started"; threadId: string; harness: string }> => {
    const requestId = randomUUID();
    let queuedNow: ((harness: string) => void) | undefined;
    const queued = new Promise<{ queuedOn: string }>(resolve => {
      queuedNow = harness => resolve({ queuedOn: harness });
    });
    const off = bus.on("session.queued", e => {
      if (e.type === "session.queued" && e.requestId === requestId) queuedNow?.(e.harness);
    });
    try {
      const started = ctx.sessionsApi.start(workspaceId, { ...o, requestId }, origin);
      const first = await Promise.race([started, queued]);
      if ("queuedOn" in first) {
        started.catch((e: unknown) => console.warn(`a message waiting in thread ${threadWord(o.thread ?? "")} was not sent: ${e instanceof Error ? e.message : String(e)}`));
        return { outcome: "queued", threadId: o.thread!, harness: first.queuedOn };
      }
      const view = first.view();
      return { outcome: first.outcome === "steered" ? "steered" : "started", threadId: view.threadId ?? view.id, harness: view.harness };
    } finally {
      off();
    }
  };

  /** A message into the workspace's first thread, which is the one the work was opened in; one with none opens one. */
  const toFirstThread = (workspaceId: string, prompt: string, origin: Caller | undefined): ReturnType<typeof sendDetached> => {
    const first = [...sessions.values()].map(v => v.view).filter(v => v.workspaceId === workspaceId && v.threadId !== undefined).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0];
    return sendDetached(workspaceId, { prompt, ...(first?.threadId !== undefined ? { thread: first.threadId } : {}) }, origin);
  };

  /** The line the machine's row carries while the runtime is doing something to its daemon; undefined clears it. */
  const noteDaemon = async (entry: LiveWorkspace, note: string | undefined): Promise<void> => {
    if (note === undefined) ctx.daemonNotes.delete(entry.record.id);
    else ctx.daemonNotes.set(entry.record.id, note);
    await ctx.pushStatus(entry);
  };

  /** A line for the machine's row that rides one status and no more, so the next poll shows the row's own facts
   * again. What the row is for is the machine's rate and its nap countdown; a failure nobody here can act on must
   * not sit on top of them for the life of the host. */
  const flashDaemon = async (entry: LiveWorkspace, note: string): Promise<void> => {
    ctx.daemonNotes.set(entry.record.id, note);
    await ctx.pushStatus(entry);
    ctx.daemonNotes.delete(entry.record.id);
  };

  /** The writes of each machine's roots file, one at a time: each writes the whole file, so two at once can land in
   * either order. */
  const rootsWrites = new Map<string, Promise<unknown>>();
  const rootsWrite = <T>(machineId: string, work: () => Promise<T>): Promise<T> => {
    const done = (rootsWrites.get(machineId) ?? Promise.resolve()).then(work);
    const tail = done.catch(() => {});
    rootsWrites.set(machineId, tail);
    void tail.then(() => {
      if (rootsWrites.get(machineId) === tail) rootsWrites.delete(machineId);
    });
    return done;
  };

  /** The folders the records say this machine's daemon may browse beside its home: each one's project and checkout,
   * and the folders imports landed beside them. Derived state: the records are the one place, and the file follows
   * them on every connect, so a project that landed before the daemon read that file is browsable without a second
   * import, after a host restart too. Non-fatal: an update or a turn must not fail on it. `entry` names the machine
   * and may be a record already gone from it, whose folders the write then leaves out. `strict` is an import's
   * write, which fails the import when the machine will not take the file. */
  const writeDaemonRoots = (entry: LiveWorkspace, strict = false): Promise<void> =>
    rootsWrite(entry.record.machineId, async () => {
      // A host that has closed writes nothing more on a machine: the boot fires this at every running workspace
      // without waiting for it, and a write that landed after the close would be this process touching a computer
      // it has let go of.
      if (ctx.state.closed) return;
      // And nothing is written inside a workspace whose computer serves its daemon: that daemon reads the path off
      // the frame and browses the workspace's own rootfs, so a list of folders inside it says nothing to anybody.
      if (ctx.servedByItsComputer(entry) !== undefined && !runsInFolder(entry.record.kind)) return;
      // Every checkout the daemon serving this machine has to browse, not this workspace's alone: the file is that
      // daemon's one list and is written whole, and on the computer the host runs on one daemon serves every
      // workspace here, each in a copy of the project folder at a path of its own. Read once the write before has
      // landed, so a write never puts back a list older than the one already there.
      const sharing = [...live.values()].filter(e => e.record.machineId === entry.record.machineId);
      const dests = [...new Set(sharing.flatMap(e => [ctx.projectHeld(e.record.project).path, ctx.checkoutOf(e.record), ...(e.record.landed ?? [])]))];
      // Through the kind, which is what knows where that machine's daemon looks.
      const written = ctx.moduleOf(entry.record.kind).roots(entry, dests);
      if (strict) return written;
      await written.catch((e: unknown) => console.warn(`browsable folders for ${entry.record.id} not written on ${entry.machine.id}: ${(e instanceof Error ? e.message : String(e)).slice(-200)}`));
    });

  /** Settles once no turn is running on the workspace: at once when none is, else when the last one ends. Replacing
   * the daemon ends the ptys under it, so the work a person or an agent started finishes first. */
  const turnRuns = (workspaceId: string): boolean => [...sessions.values()].some(s => s.view.workspaceId === workspaceId && s.view.status === "running");

  const whenNoTurnRuns = (workspaceId: string): Promise<void> => {
    if (!turnRuns(workspaceId)) return Promise.resolve();
    return new Promise(done => {
      // A turn leaves running on its done or its end and on nothing else, so this wakes twice a turn rather than
      // once per output chunk of every workspace on the bus.
      const offs: (() => void)[] = [];
      const check = (): void => {
        if (turnRuns(workspaceId)) return;
        for (const off of offs) off();
        done();
      };
      offs.push(bus.on("session.done", check), bus.on("session.end", check));
    });
  };

  /** Whether this runtime has a road to put a daemon on a machine: the kind's own module must have one wired, since
   * what a deploy needs differs by kind and only the module knows whether its host gave it one, and the bundle has
   * to reach the machine, which is the machine's own question and not its kind's. Both roads into updateDaemon
   * read this, so neither offers to deploy where the other would not. */
  const canDeployDaemon = (entry: LiveWorkspace): boolean =>
    // Nothing is put inside a workspace whose computer serves its daemon: the daemon answering for it is that
    // computer's own, moved as a computer and never as a workspace. Read here, so neither the sync nor the revive
    // offers a deploy the update would refuse.
    ctx.servedByItsComputer(entry) === undefined &&
    ctx.moduleOf(entry.record.kind).deployDaemon !== undefined &&
    landsBytes(ctx.backendFor(entry.record).capabilities, entry.machine);

  /** Every road that puts a daemon on a machine runs the kind's deploy through here, and this is the one place
   * that writes down how it went: a machine that answered with what it lacks keeps its own sentence and the
   * moment it said it, and every other ending takes them off. The record rather than a map in this process,
   * because the whole point of remembering is the next host start. */
  const deployDaemonOn = async (entry: LiveWorkspace, deploy: (e: LiveWorkspace) => Promise<void | string>): Promise<void | string> => {
    const forget = async (): Promise<void> => {
      if (entry.record.daemonRefusedAt === undefined) return;
      delete entry.record.daemonRefusedAt;
      await ctx.persist(entry.record);
    };
    try {
      const detail = await deploy(entry);
      await forget();
      return detail;
    } catch (e) {
      // Which of the three endings this is decides what the record keeps. A deploy that got past the machine's
      // own checks and fell over later proves the machine no longer lacks what it named, whatever else went
      // wrong. A machine that never answered proves nothing either way, and a box switched off has not stopped
      // lacking a compiler, so what the record already knows stands and its hour keeps running.
      const lacks = machineLacksLine(e);
      if (lacks !== undefined) {
        entry.record.daemonRefusedAt = { machineId: entry.machine.id, at: new Date(clock.now()).toISOString(), why: lacks };
        await ctx.persist(entry.record);
      } else if (!machineNeverAnswered(e)) await forget();
      throw e;
    }
  };

  /** What the machine under this record last said it lacks, and nothing another machine said: a machine replaced
   * under the record answers for itself, so the old one's sentence comes off rather than sitting on the record
   * for good and being shown on a row for a machine that is gone. */
  const lacksSaid = async (entry: LiveWorkspace): Promise<{ at: string; why: string } | undefined> => {
    const refused = entry.record.daemonRefusedAt;
    if (refused === undefined) return undefined;
    if (refused.machineId === entry.machine.id) return refused;
    delete entry.record.daemonRefusedAt;
    await ctx.persist(entry.record);
    return undefined;
  };

  /** Everything the runtime settles with a machine's daemon the moment it can reach it, and the only place that
   * does: the folders the record says it may browse, then a daemon older than this wsp replaced with this one's,
   * waiting out any running turn first. Nobody asks for it, and nothing about it is a person's to know: the panes
   * that need the new ops simply work once it lands. A failure leaves the old daemon serving, says so on the row
   * once, and puts the reason in this host's log, where the person who runs the host can read it.
   * One run per machine at a time, so two connects at once do the work once. */
  const daemonSyncs = new Map<string, Promise<void>>();
  const syncDaemon = (entry: LiveWorkspace): Promise<void> => {
    const key = entry.machine.id;
    const held = daemonSyncs.get(key);
    if (held !== undefined) return held;
    const work = (async () => {
      const module = ctx.moduleOf(entry.record.kind);
      // Nothing is deployed into a workspace whose computer serves its daemon, and no roots file is written in it:
      // the daemon answering for it is that computer's own, which the update road moves as a computer and not as a
      // workspace. A folder there is that daemon's to browse, so its roots file is written again from the records.
      if (ctx.servedByItsComputer(entry) !== undefined) {
        if (runsInFolder(entry.record.kind)) await writeDaemonRoots(entry);
        return;
      }
      // A machine that answered with what it lacks is left alone until its window is out, whether it is being
      // given a first daemon or having one replaced: the thing it has not got stops both roads, and only a person
      // can change that answer. Read off the record above every round trip below, so a tick that finds the window
      // still holding costs that machine nothing. Whether a daemon is being placed or replaced decides the words
      // alone, which say installing rather than updating.
      const placing = !module.hasDaemon(entry);
      const said = await lacksSaid(entry);
      if (said !== undefined && clock.now() - Date.parse(said.at) < DAEMON_LACKS_AGAIN_MS) return;
      await writeDaemonRoots(entry);
      // A host that cannot deploy asks no version: a line would promise an ask that changes nothing, at every connect.
      if (!canDeployDaemon(entry)) return;
      const version = await module.daemonVersion(entry);
      if (version === null) {
        unreadAt.set(entry.record.id, { machineId: key, at: clock.now() });
        console.warn(`daemon on ${key} (workspace ${entry.record.id}): version not read within ${daemonHelloTimeoutMs / 1000} s; asking again at the next reach probe`);
        return;
      }
      unreadAt.delete(entry.record.id);
      if (version >= DAEMON_VERSION) return;
      if (turnRuns(entry.record.id)) console.warn(`daemon on ${key} (workspace ${entry.record.id}): update waits for the running turn`);
      await whenNoTurnRuns(entry.record.id);
      if (entry.record.phase !== "running") return;
      await noteDaemon(entry, placing ? DAEMON_INSTALLING : DAEMON_UPDATING);
      // Marking the row awaits a push, which is several ticks wide; a turn that opened inside that window would
      // lose its ptys to the deploy, so the wait runs again until nothing is running as the deploy starts.
      while (turnRuns(entry.record.id)) await whenNoTurnRuns(entry.record.id);
      // The last read before the deploy: a machine that napped under the wait is handed no exec on a paused sandbox.
      if (entry.record.phase !== "running") {
        await noteDaemon(entry, undefined);
        return;
      }
      try {
        // The update verb's door refuses a workspace still creating, which is when the create's sync runs.
        await deployDaemonOn(entry, module.deployDaemon!);
        await writeDaemonRoots(entry);
        await noteDaemon(entry, undefined);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await noteDaemon(entry, undefined);
        // A machine that napped or went under the update did not fail one: its row says what its phase says.
        if (entry.record.phase !== "running") return;
        console.warn(`daemon on ${entry.machine.id} (workspace ${entry.record.id}) ${placing ? "not installed" : "not updated"}: ${reason}`);
        // The machine's own sentence where it gave one: it is one line, it names the thing the machine has not
        // got, and a person can act on it. A deploy that failed further in gives an npm log instead, which is
        // hundreds of characters of nothing anybody reading a row can do.
        await flashDaemon(entry, machineLacksLine(e) ?? (placing ? DAEMON_INSTALL_FAILED : DAEMON_UPDATE_FAILED));
      }
    })();
    daemonSyncs.set(key, work);
    void work.catch(() => {}).then(() => {
      if (daemonSyncs.get(key) === work) daemonSyncs.delete(key);
    });
    return work;
  };

  /** Every attempt to put a daemon back on a workspace's current machine, and when the last one was. */
  const revivedAt = new Map<string, MachineMoment>();
  /** Every workspace whose last sync could not read its daemon's version, and when that read gave up. */
  const unreadAt = new Map<string, MachineMoment>();
  /** Every workspace whose machine the provider last answered it cannot reach, with the sentence its row carries. */
  const unreached = new Map<string, { machineId: string; line: string }>();
  /** The mark on the entry's own machine; one a replaced machine left is dropped here. */
  const unreachedOf = (entry: LiveWorkspace): string | undefined => {
    const mark = unreached.get(entry.record.id);
    if (mark === undefined) return undefined;
    if (mark.machineId === entry.machine.id) return mark.line;
    unreached.delete(entry.record.id);
    return undefined;
  };
  const daemonRevivals = new Map<string, Promise<void>>();

  /** A running machine whose daemon port answers nothing gets this runtime's daemon put back on it, on the same
   * road the doctor and the golden build use and with the workspace's own token. The kernel's memory killer took
   * a daemon once and the machine sat with none for five hours while its turns, which go over the provider's
   * exec, kept running, so only the reach probe noticed (2026-09-08). Every poll that
   * measures the machine calls this, not every status the bus carries: a machine parked at no-daemon builds the
   * same status each time and the bus rightly drops the repeats, so a road listening there would try once and
   * never again. The probe window is behind the word already, since reachShown gives a row no-daemon only on the
   * second unanswered probe in a row. Unlike an update this waits out no turn: a daemon that answers nothing holds
   * no ptys to lose. One run per machine at a time. */
  const reviveDaemon = (entry: LiveWorkspace, reach: ReachState): void => {
    if (reach !== "no-daemon" || entry.record.phase !== "running") return;
    // A deploy rides the exec the provider is refusing, and its failure would flash over the row's own sentence.
    if (!canDeployDaemon(entry) || unreachedOf(entry) !== undefined) return;
    const key = entry.machine.id;
    if (daemonRevivals.has(key)) return;
    const last = revivedAt.get(entry.record.id);
    if (last !== undefined && last.machineId === key && clock.now() - last.at < DAEMON_REVIVE_AGAIN_MS) return;
    revivedAt.set(entry.record.id, { machineId: key, at: clock.now() });
    const deploy = ctx.moduleOf(entry.record.kind).deployDaemon!;
    const work = (async () => {
      await noteDaemon(entry, DAEMON_RESTARTING);
      // The last read before the deploy: a machine that napped under the note is handed no exec on a paused sandbox.
      if (entry.record.phase !== "running") {
        await noteDaemon(entry, undefined);
        return;
      }
      try {
        await deployDaemonOn(entry, deploy);
        await writeDaemonRoots(entry);
        await noteDaemon(entry, undefined);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await noteDaemon(entry, undefined);
        // A machine that napped or went while the daemon was going back on did not fail a restart.
        if (entry.record.phase !== "running") return;
        console.warn(`daemon on ${entry.machine.id} (workspace ${entry.record.id}) not restarted: ${reason}`);
        await flashDaemon(entry, DAEMON_RESTART_FAILED);
      }
    })();
    daemonRevivals.set(key, work);
    void work.catch(() => {}).then(() => {
      if (daemonRevivals.get(key) === work) daemonRevivals.delete(key);
    });
  };

  /** A machine that answered with what it lacks is offered the daemon again on the first poll after its hour is
   * out, with this host never restarted. For a machine over ssh the sync runs at hydrate and at a machine swap and
   * nowhere else, so a person who installed the compiler their machine asked for would read the refusal on their
   * row until they restarted the host. The hour itself stays where it is decided, in the sync; this says only
   * which machines are worth asking it about, and asks about none the poll did not just hear from: a status
   * carries the machine's own facts only when it answered a dial this tick, so a box that is off is left alone
   * rather than dialled a second time for the same silence, and so is one whose answer came back unreadable. The
   * window restarts on each refusal, so a machine still lacking what it named is asked once an hour and not once
   * a tick.
   * The evidence is the kind's own read of what its machine is, so only a kind whose machines answer that read can
   * be offered again: one that cannot say what it is gives the same nothing whether it is up or dark. What makes
   * that whole is that a place asks its machine for something only where wsp did not build that machine, and a
   * machine that already existed is one that answers the read; a fork asks nothing, so it records no refusal for
   * anything to re-offer. A check added to a place whose machines answer no such read would sit on its row for
   * good, so that kind answers for itself here first. */
  const offerDaemonAgain = (entry: LiveWorkspace, polled: WorkspaceStatus): void => {
    if (entry.record.daemonRefusedAt === undefined || polled.facts === undefined) return;
    void syncDaemon(entry);
  };

  /** Nothing else runs the sync again before the next connect, and a hello that missed it leaves an old daemon serving. */
  const readVersionAgain = (entry: LiveWorkspace, polled: WorkspaceStatus): void => {
    const unread = unreadAt.get(entry.record.id);
    if (unread === undefined) return;
    if (unread.machineId !== entry.machine.id) {
      unreadAt.delete(entry.record.id);
      return;
    }
    if (polled.phase !== "running" || polled.reach.state !== "reachable" || clock.now() - unread.at < DAEMON_REVIVE_AGAIN_MS) return;
    void syncDaemon(entry);
  };
  return {
    sendDetached, toFirstThread, writeDaemonRoots, turnRuns, deployDaemonOn, daemonSyncs, syncDaemon,
    revivedAt, unreadAt, unreached, unreachedOf, reviveDaemon, offerDaemonAgain, readVersionAgain,
  };
}
