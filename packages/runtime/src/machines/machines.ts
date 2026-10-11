// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from "node:crypto";
import { MachineUnreachableError, RestoreUnfinishedError, MoveUnansweredError, ResumeUnansweredError, CREATED_AT_LABEL, GOLDEN_LABEL, NAME_LABEL, OWNER_LABEL, WORKSPACE_LABEL, WSP_LABEL, Workspace, importInto, isMissing, NapRefusedError, StopRefusedError, killUntilGone, readGone, type ExecResult, type Machine, type MachineBackend, type MachineKind, type MachineShape, type MachineSpec, type MachineState, type RunOptions, type WspError, type WorkspaceHooks, type WorkspacePhase as EnginePhase, applyMachineContext, DiskSyncError, syncDisk } from "@wsp/engine";
import { type WorkspacePhase, goneRefusal, notFoundRefusal, noWorkspaceRefusal, noCommandsYetLine, WAKE_STOPPED_UP, type WorkspaceSize, type WorkspaceView, settingFor, IDLE_REASON, ALREADY_RUNNING, goldenImage, goneWords, HOSTNAME_KEPT, hostnameSetLine, NOT_GONE, GONE_UNCHECKED, RESUME_UNANSWERED, runsInFolder, placeHoldsNoImageLine } from "@wsp/protocol";
import { templateHost } from "../host-id.js";
import { backstopMs, createIdlePolicy } from "../idle.js";
import { POLL_INTERVAL_MS, phaseLeavingGone, providerSaid } from "../status.js";
import { loginEnvOn } from "../types/harness.js";
import { type WorkspaceSpec, type WorkspaceRecord, type LiveWorkspace, type StageReport, type GoldenExec, type GoneOutcome, settled, VAULTS, shapeFault, setHostname } from "../types/wiring.js";
import { AGENT_LISTS, WORKSPACES, TRANSCRIPTS, TRANSCRIPT_HEADS, TRANSCRIPT_INDEX, SESSIONS, WORKSPACE_NAMES, DROPPED, PAUSED_REASON, GONE_REASON, goneLogLine, type DroppedMachine, CREATES, KEY_PURPOSE_MAX, type PendingCreate, fingerprint, pidAlive, forwardedCalls } from "../types/internal.js";
import type { RuntimeContext, MachinesArea } from "../context.js";

export function machinesArea(ctx: RuntimeContext): MachinesArea {
  const {
    opts, backend, store, bus, goneConfirmMs, lateReadMs, clock, vaultCapBytes, defaultIdleWindowMs, hostId,
    vaultExport, live, gone, threadRecords, sessions, execs, indexFlushes, transcripts, rows, unreadIndexes,
    pendingEvents, pendingBytes, transcriptIndex, transcriptBytes,
  } = ctx;
  /** Size is always explicit: a create that names none gets the provider's own
   * default (2048 MB on Solari), not the size the record and the rate assume. */
  const forkSpec = (r: WorkspaceRecord, kind: MachineKind, image: ReturnType<typeof goldenImage>["spec"] | undefined, engine: boolean, override?: WorkspaceSpec, npmBin?: string): MachineSpec & WorkspaceSize => ({
    ...image,
    kind,
    ...(engine ? { engine: true } : {}),
    // The project's own folders on its computer, as the create recorded them: a wake mounts what the create did,
    // and the copy of the checkout it was made with is made again from the same folder.
    ...(r.spec.binds !== undefined && r.spec.binds.length > 0 ? { binds: r.spec.binds } : {}),
    ...(r.spec.copy !== undefined ? { copy: r.spec.copy } : {}),
    // The view's size rather than the row's: the row carries the guest's count, which no offer need match.
    cpu: override?.cpu ?? r.shape?.cpu ?? r.size.cpu,
    memMb: override?.memMb ?? r.shape?.memMb ?? r.size.memMb,
    envs: { ...loginEnvOn(r.place, npmBin), ...r.spec.envs, ...override?.envs },
    labels: { ...r.spec.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [WORKSPACE_LABEL]: r.id, [NAME_LABEL]: r.name, [GOLDEN_LABEL]: r.golden, [CREATED_AT_LABEL]: new Date().toISOString() },
    onIdle: "pause",
    idleTimeoutMs: backstopMs(idleWindowOf(r)),
  });
  /** The mark on every image this state makes: the host's id and this state file's owner, each in the class the
   * provider's name field has taken. Two state files on one computer read one host id, and on Box a snapshot's name
   * is its id, so the owner is what keeps one state's image from being the other's. */
  const imageMark = (): string => templateHost(hostId) + templateHost(ctx.state.owner);

  /** The store holds the attempt's key and stamp before the provider hears of it: a retry the provider never answered
   * (the connection dropped, the process died) sends the same body under the same key and gets back the machine the
   * first try booted. An answer of any kind ends the attempt and a changed request starts one, so the key after a kill
   * or a refusal is always fresh. A replay naming a dead machine is dropped and the create made anew (measured
   * 2026-09-04: the provider replays a killed machine's id). Another live process's attempt is never joined. */
  const keyedCreate = async (at: MachineBackend, purpose: string, spec: MachineSpec, waiting?: (line: string) => void, afterCorpse = false): Promise<Machine> => {
    const body = fingerprint(spec);
    const held = (await store.get(CREATES, purpose)) as PendingCreate | undefined;
    const theirs = held !== undefined && (held.host !== hostId || (held.pid !== process.pid && pidAlive(held.pid)));
    const name = purpose.length <= KEY_PURPOSE_MAX ? purpose : createHash("sha256").update(purpose).digest("hex");
    const attempt: PendingCreate = held?.body === body && !theirs
      ? { ...held, host: hostId, pid: process.pid }
      : { key: `${name}:${randomBytes(8).toString("hex")}`, createdAt: new Date().toISOString(), body, host: hostId, pid: process.pid };
    await store.put(CREATES, purpose, attempt);
    let machine: Machine;
    try {
      machine = await at.create({
        ...spec,
        idempotencyKey: attempt.key,
        ...(spec.labels?.[CREATED_AT_LABEL] !== undefined ? { labels: { ...spec.labels, [CREATED_AT_LABEL]: attempt.createdAt } } : {}),
      }, waiting);
    } catch (e) {
      if (typeof (e as WspError).status === "number") await store.delete(CREATES, purpose);
      throw e;
    }
    await store.delete(CREATES, purpose);
    if (machine.replayed === true) {
      if ((await machine.state()) === "gone") {
        if (afterCorpse) throw new Error(`create for ${purpose}: the provider replayed ${machine.id}, which is gone, under a key it had never seen (${attempt.key})`);
        console.warn(`create for ${purpose}: the replay under ${attempt.key} named ${machine.id}, which is gone; creating anew`);
        return keyedCreate(at, purpose, spec, waiting, true);
      }
      console.warn(`create for ${purpose}: ${machine.id} replayed from an earlier attempt under ${attempt.key}`);
    }
    return machine;
  };

  /** Ids this process has created and not yet recorded; the sweep must not read them as lost. */
  const inflight = new Set<string>();
  /** purpose names the record every create inside run is for; its attempts are keyed under it. */
  const claiming = <T>(purpose: string, run: (b: MachineBackend) => Promise<T>, at: MachineBackend = backend): Promise<T> => {
    const mine: string[] = [];
    const b: MachineBackend = {
      capabilities: at.capabilities,
      pricing: at.pricing,
      // The golden's builder is created through this handle, so the image the provider boots from rides along.
      ...(at.baseTemplates !== undefined ? { baseTemplates: at.baseTemplates } : {}),
      // And whether this backend's machines come up under the workspace's own name, since the fork behind this
      // handle is what would name one again.
      ...(at.namesWorkspace !== undefined ? { namesWorkspace: at.namesWorkspace } : {}),
      get: id => at.get(id),
      list: labels => at.list(labels),
      deleteSnapshot: id => at.deleteSnapshot(id),
      // Every call a backend may or may not carry, in one place: a module keeps its methods on its prototype, so
      // this handle cannot be a spread of the backend, and a call left out is one the roads inside here lose.
      ...forwardedCalls(at),
      create: async (spec, waiting) => {
        const m = await keyedCreate(at, purpose, spec, waiting);
        inflight.add(m.id);
        mine.push(m.id);
        return m;
      },
    };
    return run(b).finally(() => mine.forEach(id => inflight.delete(id)));
  };
  /** The machine with its exec reported to the recipe's listener; every other member is the provider's own, bound to it.
   * A listener that throws is warned about once and never changes an exec's result: the log records the run, it cannot fail it. */
  const observed = (machine: Machine): Machine => {
    const onExec = opts.goldenRecipe?.onExec;
    if (onExec === undefined) return machine;
    let unheard = false;
    const report = (exec: GoldenExec): void => {
      try {
        onExec(exec);
      } catch (e) {
        if (unheard) return;
        unheard = true;
        console.warn(`exec log for ${machine.id} failed, its execs go on unlogged: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const reported = async (cmd: string, call: () => Promise<ExecResult>, unlogged = false): Promise<ExecResult> => {
      const t0 = Date.now();
      try {
        const res = await call();
        // A command that says its answer is the person's own file is recorded as having run and exited; what it
        // printed is that file, and a log kept on their disk is no place for it.
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, ...(unlogged ? { exitCode: res.exitCode } : res) });
        return res;
      } catch (e) {
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
    const exec = (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => reported(cmd, () => machine.exec(cmd, o));
    // A run is one command to the log, however many execs carry it.
    const run = (script: string, o: RunOptions): Promise<ExecResult> => reported(script, () => machine.run(script, o), o.unlogged === true);
    return new Proxy(machine, {
      get(target, prop) {
        if (prop === "exec") return exec;
        if (prop === "run") return run;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  /** The entry's machine with every exec and run read for the provider's word that it cannot reach it: that refusal
   * marks the workspace and puts the sentence on the row now, and any answer takes the mark off for the next tick to
   * say, since a push here would carry the marked tick's reach without its sentence. */
  const watched = (entry: LiveWorkspace, machine: Machine): Machine => {
    const heard = async (call: () => Promise<ExecResult>): Promise<ExecResult> => {
      let res: ExecResult;
      try {
        res = await call();
      } catch (e) {
        if (e instanceof MachineUnreachableError && entry.machine.id === machine.id) {
          const standing = ctx.unreached.get(entry.record.id)?.machineId === machine.id;
          ctx.unreached.set(entry.record.id, { machineId: machine.id, line: e.message });
          if (!standing && entry.record.phase === "running") await ctx.emitStatus(entry, "unreachable", e.message);
        }
        throw e;
      }
      if (ctx.unreached.get(entry.record.id)?.machineId === machine.id) ctx.unreached.delete(entry.record.id);
      return res;
    };
    const exec = (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => heard(() => machine.exec(cmd, o));
    const run = (script: string, o: RunOptions): Promise<ExecResult> => heard(() => machine.run(script, o));
    return new Proxy(machine, {
      get(target, prop) {
        if (prop === "exec") return exec;
        if (prop === "run") return run;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  const observing = (b: MachineBackend): MachineBackend => ({ ...b, create: async spec => observed(await b.create(spec)), get: async id => observed(await b.get(id)) });
  /** Boots a golden fork for the record and writes back what the provider says it built.
   * A snapshot restores as the kind it was taken from, so the spec names that kind;
   * versions sealed before it was recorded were all sandbox. The create reads the guest's memory itself, once its
   * daemon has answered, so it forks with `readsMemory` off. */
  const fork = (record: WorkspaceRecord, bind: (machine: Machine) => void, override?: WorkspaceSpec, report?: StageReport, readsMemory = true): Promise<Machine> =>
    claiming(
      `workspace/${record.id}`,
      async b => {
        const image = ctx.keepsImages(b) ? await ctx.imageOf(record.golden) : undefined;
        const golden = image?.version;
        // A project golden's snapshot is the image; only a version's own snapshot may stand behind a template.
        const spec = forkSpec(record, golden?.kind ?? "sandbox", image === undefined ? undefined : goldenImage(image.projects === undefined && golden !== undefined ? golden : { snapshotId: record.golden }).spec, record.spec.engine === true || (golden !== undefined && (await ctx.recipeAsksEngine(golden))), override, golden?.npmBin);
        // A place that has never held this image says missing about a reference no registry has: the fork lands
        // nowhere and the sentence says where it would land until that place holds a copy.
        const machine = await b.create(spec, report === undefined ? undefined : line => report("fork-requested", line, { waiting: true })).catch((e: unknown) => {
          if (image === undefined || record.place === undefined || !isMissing(e)) throw e;
          throw Object.assign(new Error(placeHoldsNoImageLine(ctx.placeDoorOf().nameOf(record.place), spec.fromSnapshot ?? spec.template ?? record.golden)), { kind: "invalid" });
        });
        // Named by its record before the claim is released, so no sweep sees it unclaimed.
        bind(machine);
        // No line for the machine coming up: the starting line above is the step a person waits through, and a
        // fork's own id names nothing to them.
        // A machine that boots under the workspace's name is not named again: the name is on the specification the
        // computer booted it from, and the command here runs inside the workspace, where it has no right to change
        // the host name and says so on every create.
        if (!ctx.namesWorkspace(b)) {
          const named = await setHostname(machine, record.name);
          if (named.refused === undefined) report?.("hostname-set", hostnameSetLine(named.host));
          else report?.("hostname-set", HOSTNAME_KEPT, { detail: named.refused });
        }
        // The fork carries the golden's copy; this one names the workspace and reads the disk and secrets as they are now.
        const context = await applyMachineContext(machine, { workspace: { name: record.name }, ...(golden !== undefined ? { golden } : {}) });
        if (context.failure !== undefined) console.warn(`machine context for ${record.id} on ${machine.id} ${context.summary}`);
        if (golden?.npmBin !== undefined) record.npmBin = golden.npmBin;
        else delete record.npmBin;
        const shape = await ctx.shapeOf(machine);
        if (shape !== undefined) record.shape = shape;
        else delete record.shape;
        record.size = ctx.sizeBuilt(shape, spec);
        if (readsMemory && record.place === undefined) await ctx.readMemory(record, machine, b.capabilities.sizes);
        if (machine.streamUrl !== undefined) record.screen = { streamUrl: machine.streamUrl };
        else delete record.screen;
        return machine;
      },
      // The record says where its machine lives: this host's own provider, or the computer it was forked on.
      ctx.backendFor(record),
    );

  /** The machine a fork made, taken away and proven gone at the provider rather than at the delete's answer: a
   * DELETE Solari takes and does not act on would otherwise read as a machine that went. Rejects while the
   * provider still holds it, which is what keeps a record naming it. A machine gone is marked, so one the provider
   * lists running again is the sweep's to kill; a mark the store refuses is said, and the machine is still gone. */
  const unfork = async (entry: LiveWorkspace): Promise<void> => {
    const id = entry.machine.id;
    await killUntilGone(ctx.backendFor(entry.record), entry.machine, opts.killConfirm);
    await store.put(DROPPED, id, { machineId: id, at: new Date(clock.now()).toISOString() } satisfies DroppedMachine).catch((e: unknown) => {
      console.warn(`machine ${id} is gone but its mark was not stored (${e instanceof Error ? e.message : String(e)}); should the provider list it running again, the sweep reports it rather than killing it`);
    });
  };

  /** The engine knows three phases. A pause in flight is a nap to it (the wake resumes either way); a gone record's
   * machine is a stand-in it only ever meets through rebuild, which replaces the machine whatever the phase says. */
  const enginePhaseOf = (phase: WorkspacePhase): EnginePhase => {
    switch (phase) {
      case "running":
      case "napping":
      case "waking":
        return phase;
      case "pausing":
      case "gone":
        return "napping";
      default: {
        const _exhaustive: never = phase;
        return "running";
      }
    }
  };

  /** The record follows the engine once a wake, upgrade or rebuild put a machine under it; a gone record is gone no more. */
  const followMachine = (entry: LiveWorkspace): void => {
    entry.record.phase = "running";
    entry.record.machineId = entry.ws.machineId;
    entry.record.firstLife = entry.ws.isFirstLife;
    delete entry.record.gone;
    delete entry.unchecked;
    void ctx.syncDaemon(entry);
  };

  const attach = (record: WorkspaceRecord, machine: Machine): LiveWorkspace => {
    const entry: LiveWorkspace = { record, machine, ws: undefined as unknown as Workspace, generation: (live.get(record.id)?.generation ?? -1) + 1 };
    entry.machine = watched(entry, machine);
    // A merged or closed pull request reads as the record kept it and is never read again, a restart included.
    const kept = record.pr;
    if (kept !== undefined && kept.state !== "open") entry.pr = { ...kept, readAt: kept.mergedAt ?? kept.closedAt ?? 0 };
    if (record.checkout !== undefined) entry.checkout = record.checkout;
    const at = ctx.backendFor(record);
    /** A vault carries a workspace's own home onto a fresh fork of an image. A computer that keeps no image forks
     * none: such a workspace is a copy of that computer, its files stand on that computer's own disk, and its
     * pause is the stop of its machine there. So it gets none of the four hooks, a nap reads nothing off it and
     * stores nothing, a wake puts nothing back, and a stamp or a refusal an earlier nap wrote on its record is
     * about a vault it never had and goes. */
    const vaulted = ctx.keepsImages(at);
    if (!vaulted) {
      delete record.vaultedAt;
      delete record.vaultRefused;
    }
    entry.ws = new Workspace(
      machine,
      {
        goldenSnapshot: record.golden,
        // A kind that declares no lifecycle has its nap and wake refused before the engine is asked, so it never wakes.
        wakeAttempts: at.lifecycle?.budgets.wakeAttempts ?? 0,
        retire: m => gone.stop(at, m),
        resurrect: (override?: Partial<MachineSpec>) =>
          fork(record, m => {
            entry.machine = watched(entry, m);
          }, override),
        ...(vaulted
          ? ({
              // Taken off the running machine right before a replacement, capped: over the cap it says so, in the
              // one line that names the size and the cap, and the replacement goes on with no backup.
              vaultExport: async m => {
                try {
                  return await vaultExport(m, { maxBytes: vaultCapBytes });
                } catch (e) {
                  if (e !== null && typeof e === "object" && (e as { kind?: unknown }).kind === "vaultTooLarge") {
                    console.warn(`vault for ${record.id} not taken before the replacement: ${e instanceof Error ? e.message : String(e)}; replacing with no backup`);
                    return undefined;
                  }
                  throw e;
                }
              },
              vaultImport: async (m, payload) => {
                await importInto(m, payload, "/");
              },
              stashVault: async m => {
                // The vault the last landed nap stored stands until the provider pauses this machine at all.
                if (ctx.napRefusedOf(entry) !== undefined) return;
                // The disk is synced before the pause whatever the backend, so a stop that snapshots it holds a whole
                // one; a machine that cannot be asked still pauses.
                await syncDisk(entry.machine).catch((e: unknown) => {
                  console.warn(`disk sync before the nap of ${record.id} failed: ${e instanceof DiskSyncError ? e.answer : e instanceof Error ? e.message : String(e)}; napping anyway`);
                });
                // A pause that keeps the disk resumes the same machine with the home on it, so the nap reads none of
                // it; the vault is taken off the running machine at a rebuild instead.
                if (ctx.pauseKeepsDisk(at)) return;
                try {
                  await store.putBlob(VAULTS, record.id, await vaultExport(m, { maxBytes: vaultCapBytes }));
                  record.vaultedAt = new Date(clock.now()).toISOString();
                  delete record.vaultRefused;
                } catch (e) {
                  const why = e instanceof Error ? e.message : String(e);
                  // The record carries it, and the record alone: the files stay unbacked until a nap stores one, so the
                  // verdict stands on the pane's own backup line rather than passing through one nap's status.
                  record.vaultRefused = why;
                  console.warn(`nap vault for ${record.id} not stored, previous kept: ${why}`);
                }
              },
              restoreVault: async m => {
                const payload = await store.getBlob(VAULTS, record.id);
                if (payload !== undefined) await importInto(m, payload, "/");
              },
            } satisfies Pick<WorkspaceHooks, "vaultExport" | "vaultImport" | "stashVault" | "restoreVault">)
          : {}),
        // The backend settles its own moves under its own budgets; the runtime sends each once, hands the resume
        // the person's stop, and says on the row that a resume the backend gave up on is being read about.
        move: (m, move) =>
          move === "resume"
            ? m.resume(entry.wakeStop?.signal).catch(async (e: unknown) => {
                if (e instanceof ResumeUnansweredError) await ctx.saysWaking(entry, RESUME_UNANSWERED);
                throw e;
              })
            : m.pause(),
        wakeCheck: async m => {
          const expected = record.shape;
          let both = "";
          if (expected !== undefined && m.describe) {
            let actual: MachineShape;
            try {
              actual = await m.describe();
            } catch (e) {
              return `provider view of ${m.id} unavailable (${e instanceof Error ? e.message : String(e)})`;
            }
            both = `created as ${JSON.stringify(expected)}, provider view ${JSON.stringify(actual)}`;
            const fault = shapeFault(expected, actual);
            if (fault !== undefined) {
              console.warn(`wake check on ${m.id}: ${fault}; ${both}`);
              return `${fault} on ${m.id} (${both})`;
            }
          }
          const fault = await ctx.pingDaemon(entry);
          return fault === undefined || both === "" ? fault : `${fault} (${both})`;
        },
      },
      { phase: enginePhaseOf(record.phase), firstLife: record.firstLife },
    );
    live.set(record.id, entry);
    return entry;
  };

  const idleWindowOf = (r: WorkspaceRecord): number | null => settingFor(r.idleWindowMs, ctx.settingsAt(ctx.placeIdOf(r))?.napMs, defaultIdleWindowMs);

  /** Every live session and exec of a workspace ends here when its machine goes away under it; the harness's own end, if it ever comes, is dropped. */
  const endSessions = (workspaceId: string, reason: string): void => {
    for (const s of sessions.values()) if (s.view.workspaceId === workspaceId) s.end?.(reason);
    for (const e of execs) if (e.workspaceId === workspaceId) e.end(reason);
  };

  /** Everything a workspace left on this side once its machine is dealt with: live state, flushes, stored rows, vault. */
  const drop = async (id: string): Promise<void> => {
    const going = live.get(id);
    going?.lateRead?.();
    // Whatever this host was holding open about the machine goes with the record that named it: the child
    // carrying the road to a machine over ssh would otherwise hold a port for a workspace nobody can name.
    if (going !== undefined) {
      await ctx.moduleOf(going.record.kind)
        .dropped(going)
        .catch((e: unknown) => console.warn(`${going.record.name}'s machine ${going.machine.id} kept something of this host's: ${e instanceof Error ? e.message : String(e)}`));
    }
    live.delete(id);
    // A folder on this computer goes from its daemon's roots file with its record, since the computer and the
    // folder both stay; a fork's machine goes with its record and takes its file along.
    if (going !== undefined && runsInFolder(going.record.kind)) await ctx.writeDaemonRoots(going);
    ctx.revivedAt.delete(id);
    ctx.unreadAt.delete(id);
    ctx.unreached.delete(id);
    ctx.polledReach.delete(id);
    ctx.napRefusals.delete(id);
    transcripts.delete(id);
    transcriptBytes.delete(id);
    pendingEvents.delete(id);
    pendingBytes.delete(id);
    transcriptIndex.delete(id);
    ctx.daemonNotes.delete(id);
    // Every thread this workspace drops takes its slate with it, as a thread's own delete does: its record, its
    // timers (an always one would tick on for a thread nobody can reach) and its folder.
    const dropped = new Set<string>();
    for (const [threadId, held] of threadRecords) if (held.workspaceId === id) dropped.add(threadId);
    for (const s of sessions.values()) if (s.view.workspaceId === id && s.view.threadId !== undefined) dropped.add(s.view.threadId);
    for (const [handleId, s] of sessions) if (s.view.workspaceId === id) sessions.delete(handleId);
    for (const [threadId, kept] of ctx.keptAgents) if (kept.workspaceId === id) ctx.reapKept(threadId);
    for (const [threadId, held] of threadRecords) if (held.workspaceId === id) threadRecords.delete(threadId);
    for (const threadId of dropped) await ctx.slates.forget(threadId);
    ctx.viewedMarks.delete(id);
    live.get(id)?.prPoll?.();
    ctx.cancelFlush(id);
    await ctx.transcriptQueue.get(id);
    ctx.transcriptQueue.delete(id);
    await indexFlushes.get(id);
    indexFlushes.delete(id);
    await store.delete(WORKSPACES, id);
    await store.deleteBlob(TRANSCRIPTS, id);
    rows?.clear(id);
    unreadIndexes.delete(id);
    await store.deleteBlob(TRANSCRIPT_HEADS, id);
    await store.deleteBlob(TRANSCRIPT_INDEX, id);
    await ctx.dropSentImages(id, "all");
    ctx.keptWrites.delete(id);
    await store.delete(WORKSPACE_NAMES, id);
    await store.delete(SESSIONS, id);
    await store.delete(CREATES, `workspace/${id}`);
    await store.deleteBlob(VAULTS, id);
    // The lists its agents answered go with the last workspace on that machine.
    const machineId = going?.machine.id;
    if (machineId !== undefined && ![...live.values()].some(e => e.machine.id === machineId)) {
      for (const key of await store.keys(AGENT_LISTS)) if (key.startsWith(`${machineId}:`)) await store.delete(AGENT_LISTS, key);
    }
    bus.emit({ type: "workspace.deleted", workspaceId: id });
  };

  // Pausing is persisted and pushed before the provider is asked, so a list
  // fetched mid-pause never says running, and the sessions end while the
  // machine can still be told to stop them.
  const napWith = async (id: string, reason?: string): Promise<WorkspaceView> => {
    const entry = await ctx.entryOf(id);
    if (await runsUnderNapping(entry)) await adoptRunning(entry);
    if (entry.napping) return entry.napping;
    if (entry.record.phase !== "running") return ctx.view(entry.record);
    entry.napping = (async () => {
      try {
        entry.record.phase = "pausing";
        await ctx.persist(entry.record);
        await ctx.emitStatus(entry, "napping");
        try {
          await entry.ws.nap();
        } catch (e) {
          // A 404 the pause answered with is a sighting like any other: it settles only where the state read agrees,
          // and a machine still running takes the road any other refused pause takes.
          if (isMissing(e) && settled(await settleGone(entry, goneWords(entry.record.machineId, { by: "pause", at: clock.now(), answer: providerSaid(e) })))) throw e;
          entry.record.phase = entry.ws.currentPhase;
          await ctx.persist(entry.record);
          if (e instanceof NapRefusedError) {
            if (ctx.napRefusedOf(entry) === undefined) console.warn(`the provider does not pause ${entry.machine.id} of ${id} (${e.said}); an idle nap waits for the backstop and exports no vault until a pause lands`);
            ctx.napRefusals.set(id, { machineId: entry.machine.id, said: e.said });
          }
          if (e instanceof StopRefusedError) ctx.stopRefusals.set(id, { machineId: entry.machine.id, said: e.said });
          await ctx.emitStatus(entry, ctx.reachOf(entry), e instanceof Error ? e.message : String(e));
          throw e;
        }
        // The reason says the machine paused, so it is written once the provider has confirmed that.
        endSessions(id, PAUSED_REASON);
        ctx.napRefusals.delete(id);
        ctx.stopRefusals.delete(id);
        entry.record.phase = "napping";
        delete entry.unchecked;
        await ctx.persist(entry.record);
        bus.emit({ type: "workspace.napped", workspaceId: id });
        await ctx.emitStatus(entry, "napping", reason);
        return ctx.view(entry.record);
      } finally {
        delete entry.napping;
      }
    })();
    return entry.napping;
  };

  /** One read of the provider a while after a wake gave up: a resume the runtime stopped waiting on can land later,
   * and a record still saying napping over a machine that runs would bill under a paused row until a verb met it.
   * The read that finds it running adopts, as any verb would. */
  const armLateRead = (entry: LiveWorkspace): void => {
    entry.lateRead?.();
    entry.lateRead = clock.schedule(() => {
      delete entry.lateRead;
      void runsUnderNapping(entry)
        .then(runs => (runs ? adoptRunning(entry) : undefined))
        .catch((e: unknown) => console.warn(`late read of ${entry.record.id}: ${e instanceof Error ? e.message : String(e)}`));
    }, lateReadMs, { unref: true });
  };

  /** The provider paused the machine outside a nap (its idle timer, a console click): the record follows the fact, so a wake resumes it the normal way. */
  const adoptPause = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running" || entry.napping || entry.waking) return;
    entry.ws.notePaused();
    ctx.napRefusals.delete(entry.record.id);
    entry.record.phase = "napping";
    delete entry.unchecked;
    await ctx.persist(entry.record);
    endSessions(entry.record.id, PAUSED_REASON);
    bus.emit({ type: "workspace.napped", workspaceId: entry.record.id, found: true });
    await ctx.emitStatus(entry, "napping", "paused outside wsp");
  };
  /** One read of the provider for a record that says napping: true when the machine runs there, so the pause never
   * took or nobody wrote the resume. A read the provider refuses answers false; the record's word stands until a
   * verb meets the machine. */
  const runsUnderNapping = async (entry: LiveWorkspace): Promise<boolean> =>
    entry.record.phase === "napping" && (await entry.machine.state().catch(() => "paused")) === "running";
  /** The provider runs a machine the record calls napping: the record follows the fact and the machine is reached
   * like any running one. Nothing is resumed, so the first life the record holds is untouched. */
  const adoptRunning = (entry: LiveWorkspace): Promise<void> => {
    if (entry.adopting) return entry.adopting;
    if (entry.record.phase !== "napping" || entry.napping || entry.waking) return Promise.resolve();
    entry.adopting = (async () => {
      try {
        entry.ws.noteRunning();
        followMachine(entry);
        entry.unchecked = true;
        await ctx.persist(entry.record);
        bus.emit({ type: "workspace.woken", workspaceId: entry.record.id, machineId: entry.record.machineId });
        await ctx.emitStatus(entry, ctx.reachOf(entry), ALREADY_RUNNING);
      } finally {
        delete entry.adopting;
      }
    })();
    return entry.adopting;
  };
  /** What a gone verdict is checked against, a short wait after the call that made it: the provider read until
   * GONE_READS reads in a row answer gone, since a gateway copy that never held the machine answers 404 while the
   * other bills on. A read that fails another way confirms nothing and answers its error. */
  const goneConfirmed = async (backend: MachineBackend, machineId: string): Promise<MachineState | Error> => {
    if (goneConfirmMs > 0) await new Promise<void>(resolve => void clock.schedule(() => resolve(), goneConfirmMs, { unref: true }));
    return readGone(backend, machineId).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  };
  /** The one road to gone, whichever call found the provider no longer knew the machine (deleted behind wsp, or
   * expired): the verdict is confirmed, and where it holds the record follows the fact and stays there. Until then
   * the record keeps the phase it had, so the row and the meter go on reading the machine as billing and the sweep
   * spares it as claimed. The gone event closes the awake stretch with a cost tick at this instant, drops the idle
   * window and ends the sessions; the row and the one log line carry the words; rebuild and delete are the roads out. */
  const settleGone = async (entry: LiveWorkspace, reason: string): Promise<GoneOutcome> => {
    const machineId = entry.record.machineId;
    const read = await goneConfirmed(ctx.backendFor(entry.record), machineId);
    if (read !== "gone") {
      const followed = read instanceof Error ? `the reads that followed failed: ${read.message}` : `the state read that followed said ${read}`;
      console.warn(`workspace ${entry.record.id} is not gone: ${reason}, and ${followed}`);
      return read instanceof Error ? "unchecked" : "not-gone";
    }
    return markGone(entry, machineId, reason);
  };
  /** A verdict already confirmed, written: the record, the sessions, the event and the row move together. A delete
   * under way or done has the last word, so a record no longer live, or being deleted, is written nothing. */
  const markGone = async (entry: LiveWorkspace, machineId: string, reason: string): Promise<GoneOutcome> => {
    if (entry.record.phase === "gone" || entry.record.machineId !== machineId) return "moot";
    if (live.get(entry.record.id) !== entry || entry.deleting !== undefined) return "moot";
    entry.record.phase = "gone";
    delete entry.unchecked;
    entry.record.gone = reason;
    await ctx.persist(entry.record);
    endSessions(entry.record.id, GONE_REASON);
    console.warn(goneLogLine(entry.record.id, reason));
    bus.emit({ type: "workspace.gone", workspaceId: entry.record.id, machineId: entry.record.machineId, reason });
    await ctx.emitStatus(entry, "gone", reason);
    return "settled";
  };
  /** Records whose gone verdict is being read again: the poll sees the same 404 every tick while the reads run. */
  const rereading = new Set<string>();
  /** A sighting from outside a verb (the poll, the sweep): a nap or a wake in flight meets the machine itself and
   * settles what it finds, so the sighting defers to it. The row never read gone, so a verdict that did not hold
   * leaves it as it was, and one nothing could check says so. */
  const adoptGone = async (entry: LiveWorkspace, reason: string): Promise<void> => {
    const id = entry.record.id;
    if (entry.record.phase === "gone" || entry.napping || entry.waking || rereading.has(id)) return;
    rereading.add(id);
    try {
      if ((await settleGone(entry, reason)) === "unchecked") await ctx.emitStatus(entry, ctx.reachOf(entry), GONE_UNCHECKED);
    } finally {
      rereading.delete(id);
    }
  };
  /** A record marked gone over a machine the provider still holds: the state read by id is the word on gone, so the
   * record follows it back rather than leaving a rebuild to abandon a healthy machine that would bill on unrecorded.
   * The phase the record left gone for, or undefined when this read moved nothing. */
  const recoverGone = async (entry: LiveWorkspace): Promise<"running" | "napping" | undefined> => {
    if (entry.record.phase !== "gone" || entry.napping || entry.waking) return undefined;
    const read = await entry.machine.state().catch(() => undefined);
    const phase = read === undefined ? undefined : phaseLeavingGone(read);
    if (phase === undefined) return undefined;
    if (phase === "running") {
      entry.ws.noteRunning();
      followMachine(entry);
    } else {
      entry.ws.notePaused();
      entry.record.phase = phase;
      delete entry.record.gone;
    }
    await ctx.persist(entry.record);
    if (phase === "running") bus.emit({ type: "workspace.woken", workspaceId: entry.record.id, machineId: entry.record.machineId });
    else bus.emit({ type: "workspace.napped", workspaceId: entry.record.id, found: true });
    await ctx.emitStatus(entry, phase === "running" ? ctx.reachOf(entry) : "napping", NOT_GONE);
    return phase;
  };
  bus.on("workspace.status", e => {
    if (e.type !== "workspace.status") return;
    // No session ends on a reach verdict: the probe reads this computer's own road, and a resolver that dropped one
    // name for three minutes on 2026-09-12 read two live machines dark and cost every turn on them its process.
    const entry = live.get(e.status.id);
    if (entry === undefined) return;
    if (e.status.phase === "running" && e.status.machineState === "paused") void adoptPause(entry);
  });

  /** How long the machine behind a record has been quiet by its own computer's reading, where that computer
   * counts one. A read that fails says nothing about the workspace, and the stop goes ahead: a backend that
   * cannot be asked is a backend that does not answer. */
  const quietOf = async (id: string): Promise<number | undefined> => {
    const entry = live.get(id);
    if (entry === undefined || entry.record.phase !== "running") return undefined;
    // Called on the lifecycle itself, as the backstop below is, rather than pulled off it and called detached:
    // one interface, and an implementer is free to write this as a method, which keeps its own object only if
    // the call goes through it.
    return ctx.backendFor(entry.record).lifecycle?.quietForMs?.(entry.machine).catch((e: unknown) => {
      console.warn(`quiet figure of ${id} not read: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
  };

  const idle = createIdlePolicy({
    windowOf: id => {
      const entry = live.get(id);
      if (entry === undefined) return null;
      const windowMs = idleWindowOf(entry.record);
      // A refusal that stands is asked again only at the backstop; a window that is off stays off.
      return windowMs !== null && ctx.napRefusedOf(entry) !== undefined ? backstopMs(windowMs) : windowMs;
    },
    onIdle: async (id, windowMs) => {
      // What the computer running it can see of the workspace working, asked once here rather than counted by
      // the timer: a dev server somebody is clicking through and a build somebody started answer with a figure
      // inside the window, and the window starts over instead of the workspace stopping under them. A backend
      // that cannot say leaves the stop to this host's own clock, which is every provider.
      const quiet = await quietOf(id);
      if (quiet !== undefined && quiet < windowMs) {
        idle.touch(id);
        return;
      }
      try {
        await napWith(id, IDLE_REASON.of(windowMs));
      } catch (e) {
        if (e instanceof MoveUnansweredError) throw e;
        // A machine the pause found gone settled its record on the way out; the gone event dropped this window.
        if (isMissing(e)) return;
        // The provider answered with a refusal: asking again at once changes nothing, so a full window starts from
        // its answer, the backstop where the refusal stands for the machine, and the row is pushed once more with
        // that window, the words unchanged. A refusal that stands was logged once, where the pause met it.
        idle.touch(id);
        const entry = live.get(id);
        if (entry !== undefined) await ctx.emitStatus(entry, ctx.reachOf(entry), ctx.napRefusedReason(entry) ?? ctx.stopRefusedReason(entry) ?? (e instanceof Error ? e.message : String(e)));
        if (!(e instanceof NapRefusedError)) console.warn(`idle nap of ${id} was answered with ${providerSaid(e)}; a full ${Math.round(windowMs / 60_000)} min window starts over`);
      }
    },
    // A row left running by a restart that could not reach its run holds no hold, and its turn is still working there.
    busy: id => [...sessions.values()].some(s => s.view.workspaceId === id && s.view.status === "running"),
    retryMs: opts.status?.pollIntervalMs ?? POLL_INTERVAL_MS,
    clock,
    // A backend whose backstop is pushed rather than set at create hears the instant on every arming of a running
    // machine; the backend decides whether one is worth a call, and a call that fails changes nothing about the
    // window. A touch on a napped or gone workspace arms a window too, but its machine needs no stop timer.
    onBackstop: (id, until) => {
      const entry = live.get(id);
      if (entry === undefined || entry.record.phase !== "running") return;
      void ctx.backendFor(entry.record)
        .lifecycle?.backstop?.(entry.machine, until)
        .catch((e: unknown) => console.warn(`backstop of ${id} on ${entry.machine.id} not set: ${e instanceof Error ? e.message : String(e)}`));
    },
  });
  // Every road into a workspace the runtime can see starts its window over;
  // typing over the browser's daemon link arrives as workspaces.touch.
  for (const type of ["session.start", "session.delta", "session.done", "session.end", "session.steer", "inbox.file", "workspace.woken", "workspace.upgraded", "project.import", "project.export"] as const) {
    bus.on(type, e => idle.touch((e as { workspaceId: string }).workspaceId));
  }
  bus.on("workspace.created", e => e.type === "workspace.created" && idle.touch(e.workspace.id));
  for (const type of ["workspace.napped", "workspace.gone", "workspace.deleted"] as const) {
    bus.on(type, e => idle.forget((e as { workspaceId: string }).workspaceId));
  }

  /** A machine running on a provider read alone answers a wake or a launch once it takes commands: a Boat box reads
   * running while its disk streams in and refuses every command until it is done. The row reads waking meanwhile,
   * every caller shares the one proof, and the row's stop ends it at once. A delete that took the record while the
   * proof asked has the last word; a machine the provider no longer has takes the gone road; otherwise the record
   * goes back to running, and only a proof that landed drops the mark. */
  const proven = (entry: LiveWorkspace): Promise<WorkspaceView> => {
    if (entry.waking) return entry.waking;
    const prove = entry.machine.proveRoad?.bind(entry.machine);
    if (prove === undefined) {
      delete entry.unchecked;
      return Promise.resolve(ctx.view(entry.record));
    }
    const stop = new AbortController();
    entry.wakeStop = stop;
    /** Before every write: a delete under way is waited for, and one that took the record leaves nothing to write. */
    const stillLive = async (): Promise<void> => {
      await entry.deleting?.catch(() => {});
      if (live.get(entry.record.id) !== entry) throw notFoundRefusal(noWorkspaceRefusal(entry.record.name));
    };
    entry.waking = (async () => {
      try {
        await stillLive();
        entry.record.phase = "waking";
        await ctx.persist(entry.record);
        await ctx.emitStatus(entry, "napping");
        const outcome = stop.signal.aborted
          ? ("stopped" as const)
          : await Promise.race([
              prove(stop.signal).then(() => "proven" as const, (e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
              new Promise<"stopped">(resolve => stop.signal.addEventListener("abort", () => resolve("stopped"), { once: true })),
            ]);
        await stillLive();
        if (outcome instanceof Error && isMissing(outcome)) {
          entry.record.phase = "running";
          const gone = await settleGone(entry, goneWords(entry.record.machineId, { by: "wake", at: clock.now(), answer: providerSaid(outcome) }));
          await stillLive();
          if (settled(gone)) throw new Error(goneRefusal(entry.record.name, "wake", entry.record.gone));
        }
        if (outcome === "proven") delete entry.unchecked;
        const said = outcome === "proven" ? undefined : outcome === "stopped" ? WAKE_STOPPED_UP : outcome instanceof RestoreUnfinishedError ? noCommandsYetLine(entry.record.name, outcome.message) : outcome.message;
        entry.record.phase = "running";
        await ctx.persist(entry.record);
        await ctx.emitStatus(entry, ctx.reachOf(entry), said);
        if (outcome === "proven") return ctx.view(entry.record);
        throw outcome === "stopped" || outcome instanceof RestoreUnfinishedError ? new Error(said) : outcome;
      } finally {
        delete entry.waking;
        if (entry.wakeStop === stop) delete entry.wakeStop;
      }
    })();
    return entry.waking;
  };

  return {
    imageMark, inflight, claiming, observed, observing, fork, unfork, followMachine, attach, endSessions, drop, napWith,
    armLateRead, adoptPause, runsUnderNapping, adoptRunning, proven, settleGone, markGone, rereading, adoptGone, recoverGone,
    idle,
  };
}
