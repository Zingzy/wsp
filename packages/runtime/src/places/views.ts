// SPDX-License-Identifier: AGPL-3.0-only
import type { Socket } from "node:net";
import {
  HERE_PLACE_ID,
  PLACE_KEY_REFUSAL,
  forkRoom,
  placeBlocked,
  placeNoToolsLine,
  pluginOffLine,
  PendingComputer,
  SETUP_STEP_WORDS,
  floorFailedLine,
  BackendFacts,
  type AgentSignInState,
  type DaemonEvent,
  type PlaceReport,
  type PlaceView,
  PLACE_CODE_REFUSAL,
  placeDaemonBehind,
  leaveAsks,
  placeUpdateLine,
  buildsImages,
  type PlaceProveRequest,
  macKindOf,
} from "@wsp/protocol";
import { LinkBackend, PlaceMachine, machineServerPort, serversOutLines, unmergeServers, type MachineBackend } from "@wsp/engine";
import { verifyPlaceBytes } from "@wsp/keys";
import { PLACES, CAPS, DEFAULT_COLLECTION, DEFAULT_ID, type PlaceRecord, madeBySetup, appliedView, type PlaceLogin } from "./types.js";
import {
  bounded, takenReport, signInsOf, ADD_FACTS_MS, CAPACITY_MS, PENDING, type PendingRecord, pendingView,
  ADD_STOPPED_LINE, ADD_STOPPED_FIX, ADD_NOT_TAKEN_BACK_LINE, UNDO_MS, firstLineOf, UNMERGE_MS,
} from "./helpers.js";
import type { PlaceDoorContext } from "./context.js";
import type { PlaceRecordsArea } from "./records.js";
import type { PlaceSetupArea } from "./setup.js";

/** Pending adds, what a remove takes off a computer, the link's tunnels, and the rows a client reads. */
export function placeViews(ctx: PlaceDoorContext, recordArea: PlaceRecordsArea, setupArea: PlaceSetupArea) {
  const { opts, store, devices, wiring, live, kept, backends, forwards, emit } = ctx;
  const {
    providerIds, providerBackend, providerRate, providerSizes, imageFacts, recordOf, settingsHeld, withCap, awaiting,
    keep, defaultId, inTurn, markDefault, markHeld, inRecordTurn,
  } = recordArea;
  const { waiting, closedAt, woken, linkTo } = setupArea;

  /** The adds that have not reached Set up, by id, as the store keeps them: each with what the installer left to
   * take an install back, which no client reads. */
  const pendingRecords = async (): Promise<PendingRecord[]> =>
    (await store.list(PENDING))
      .flatMap(v => {
        const parsed = PendingComputer.passthrough().safeParse(v);
        return parsed.success ? [parsed.data as PendingRecord] : [];
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const putPending = async (p: PendingRecord): Promise<void> => {
    await store.put(PENDING, p.id, p);
    opts.onSetup?.({ type: "place.pending", id: p.id, pending: pendingView(p) });
  };
  const dropPending = async (id: string): Promise<void> => {
    await store.delete(PENDING, id);
    opts.onSetup?.({ type: "place.pending", id });
  };

  /** The floor on a computer that joined with nothing picked yet, so it is on by the time the person has chosen:
   * the pending add moves to choosing either way, and a floor that failed says so on it. */
  const floorWhileChoosing = async (pending: PendingRecord, placeId: string): Promise<void> => {
    const provisioner = wiring.provision;
    const record = await recordOf(placeId);
    const home = record?.report.login["HOME"];
    if (provisioner === undefined || record === undefined || home === undefined) {
      await putPending({ ...pending, placeId, step: "choosing" });
      return;
    }
    await putPending({ ...pending, placeId, step: "floor" });
    const machine = new PlaceMachine(linkTo(placeId), { id: record.name, home });
    const failed = await provisioner
      .floor(machine, { home }, () => {})
      .then(rows => rows.filter(r => r.outcome === "failed"))
      .catch((e: unknown) => [{ id: "floor", label: SETUP_STEP_WORDS.floor, outcome: "failed" as const, note: firstLineOf(e) }]);
    const now = (await store.get(PENDING, pending.id)) === undefined ? undefined : pending;
    if (now === undefined) return;
    await putPending({ ...pending, placeId, step: "choosing", ...(failed.length > 0 ? { failed: { said: floorFailedLine(failed) } } : {}) });
  };

  /** The pending adds whose floor runs here now, so a second link does not start it again. */
  const flooring = new Set<string>();
  const floorOnce = async (pending: PendingRecord, placeId: string): Promise<void> => {
    flooring.add(pending.id);
    try {
      await floorWhileChoosing(pending, placeId);
    } finally {
      flooring.delete(pending.id);
    }
  };

  /** An add the host stopped while wsp went on, taken back off that computer by the script its installer left, over
   * the login it used. The pending add then reads as failed with what happened, for the person to add it again. */
  const takenBack = async (pending: PendingRecord): Promise<void> => {
    const ssh = pending.login;
    const said =
      ssh === undefined || pending.undo === undefined || wiring.undo === undefined
        ? ADD_NOT_TAKEN_BACK_LINE
        : await wiring.undo({ ssh, ...(pending.keyPath !== undefined ? { keyPath: pending.keyPath } : {}), ...(pending.hostKey !== undefined ? { hostKey: pending.hostKey } : {}) }, pending.undo).then(
            () => ADD_STOPPED_LINE,
            (e: unknown) => `${ADD_NOT_TAKEN_BACK_LINE}: ${firstLineOf(e)}`,
          );
    await putPending({ ...pending, failed: { said, fix: ADD_STOPPED_FIX } });
  };

  /** The servers wsp merged into the agents' own files on that computer, taken back out over the link before the
   * leave takes the rest: the computer itself driven as a machine, the way the recipe's job drives it. Nothing
   * here fails the leave, which is a decision already made by the time it runs. */
  const unmergedOver = async (placeId: string, held: PlaceRecord): Promise<string[]> => {
    const home = held.report.login["HOME"];
    if (home === undefined) return [];
    const machine = new PlaceMachine(linkTo(placeId), { id: held.name, home });
    const took = await bounded(unmergeServers(machineServerPort(machine), home), UNMERGE_MS, `the servers wsp merged into the agents' files on ${held.name}`).catch(() => []);
    return took.flatMap(serversOutLines);
  };

  /** The plugins the setup put on that computer, each taken off by its agent's own command, the way a sync takes
   * one out: over the link where it is up, else over the login the install used. A plugin the computer had before
   * wsp stays. Answers the lines for the ones that came off and the names of the ones that did not, which the remove
   * says; nothing here fails it. */
  const pluginsOff = async (placeId: string, held: PlaceRecord, linked: boolean, login: PlaceLogin | undefined, sudoPassword?: string): Promise<{ off: string[]; kept: string[] }> => {
    const home = held.report.login["HOME"];
    const names = madeBySetup(held, "plugins");
    const undo = wiring.provision?.undo;
    if (home === undefined || held.picks === undefined || names.length === 0 || undo === undefined) return { off: [], kept: [] };
    const planned = await undo(held.picks, names.map(name => ({ kind: "plugins" as const, name })), { home }).catch(() => []);
    const machine = linked ? new PlaceMachine(linkTo(placeId), { id: held.name, home }) : undefined;
    const runOver = wiring.runOver;
    const run = async (cmd: string): Promise<boolean> => {
      if (machine !== undefined) return (await machine.exec(cmd, { timeoutMs: UNDO_MS }).catch(() => undefined))?.exitCode === 0;
      if (login === undefined || runOver === undefined) return false;
      return (await runOver(login, cmd, UNDO_MS, sudoPassword).catch(() => undefined))?.exitCode === 0;
    };
    const off: string[] = [];
    const kept = names.filter(name => !planned.some(u => u.key === `plugins/${name}` && u.cmd !== undefined));
    for (const u of planned) {
      if (u.cmd === undefined) continue;
      if (await run(u.cmd)) off.push(pluginOffLine(u.label));
      else kept.push(u.label);
    }
    return { off, kept };
  };

  /** The record with what that computer forks with on it, waited for no longer than one round trip on a link
   * that is up: the read behind this writes the record whenever the answer lands, so a computer slower than
   * that is joined, or updated, all the same and its row fills in at the read after. Where the facts are already
   * on the record this answers at once, since the read is dropped for a computer that has said. */
  const factsOn = async (placeId: string, held: PlaceRecord): Promise<PlaceRecord> => {
    const read = ctx.door
      .forkingBackend(placeId)
      .then(async () => (await recordOf(placeId)) ?? held)
      .catch(() => held);
    return Promise.race([
      read,
      new Promise<PlaceRecord>(resolve => {
        const timer = setTimeout(() => resolve(held), ADD_FACTS_MS);
        timer.unref?.();
      }),
    ]);
  };

  /** The backend a place offers, off the facts it last sent. Built once per place and kept: the link under it reads
   * the live socket at every call, so one backend serves a computer that comes and goes. */
  const backendFrom = (placeId: string, facts: BackendFacts): MachineBackend => {
    const made = LinkBackend.of(linkTo(placeId), facts);
    backends.set(placeId, made);
    return made;
  };

  /** A frame the forward owns rather than the panes: the bytes of one connection riding a tunnel, or its end.
   * Answers whether it was taken; a tunnel another road on this link opened is that road's to read. */
  const tunnelled = (placeId: string, e: DaemonEvent): boolean => {
    if (e.type !== "tunnel.data" && e.type !== "tunnel.end") return false;
    const conn = connOf(placeId, e.tunnelId);
    if (conn === undefined) return false;
    if (e.type === "tunnel.data") conn.write(Buffer.from(e.data, "base64"));
    else conn.end();
    return true;
  };
  const connOf = (placeId: string, tunnelId: string): Socket | undefined => {
    for (const [key, f] of forwards) {
      if (!key.startsWith(`${placeId}:`)) continue;
      const conn = f.conns.get(tunnelId);
      if (conn !== undefined) return conn;
    }
    return undefined;
  };

  /** Frees what this host holds about one link: the poller, the reach and the socket. The place's own redial is
   * what brings the next one. */
  const cut = (placeId: string, reason: string): void => {
    const held = live.get(placeId);
    if (held === undefined) return;
    live.delete(placeId);
    clearInterval(held.seen);
    void held.forward?.then(f => f.close()).catch(() => undefined);
    held.reach.close();
    held.socket.close(1000, reason);
  };

  /** How many forks run on a place and how many more it takes now, off what its own backend says about the computer
   * it runs on. Only what this host already knows is waited for: a table is something a person is watching, so a
   * place that has not yet said what it forks with shows nothing in that column and is asked behind the listing, and
   * one that does not answer in time shows nothing rather than a guess. */
  const forksOf = async (record: PlaceRecord): Promise<{ running: number; room: number } | undefined> => {
    const linked = live.has(record.id);
    const backend = linked ? ctx.door.backendOf(record.id) : undefined;
    if (backend === undefined) {
      if (linked) void ctx.door.forkingBackend(record.id).catch(() => undefined);
      return undefined;
    }
    if (backend.capacity === undefined) return undefined;
    try {
      const capacity = await bounded(backend.capacity(), CAPACITY_MS, `machine.capacity on ${record.name}`);
      const image = capacity.images.reduce((most, i) => Math.max(most, i.sizeBytes), 0);
      return {
        // What runs there now. A napping fork holds the disk its copy takes and no cpu or memory, so counting it
        // here would say a slot is taken that a create can have; the workspace list is where a napping one is
        // counted and its state said, and the disk it holds is the row's own disk free column.
        running: capacity.machines.running,
        // What a fork takes there, not what it would be asked for: a computer clamps a machine to its own share.
        room: forkRoom(capacity, Math.min(backend.pricing.defaultSize.memMb, capacity.machineMemMb), image === 0 ? undefined : image),
      };
    } catch {
      return undefined;
    }
  };

  const viewOf = (record: PlaceRecord, defaulted: string | undefined): PlaceView => {
    const blocked = placeBlocked(record.name, record.report);
    const toolsBlocked = placeNoToolsLine(record.name, record.report);
    const mac = record.report.model === undefined ? undefined : macKindOf(record.report.model);
    return {
      id: record.id,
      kind: "computer",
      name: record.name,
      default: defaulted === record.id,
      os: record.report.os,
      ...(mac !== undefined ? { mac } : {}),
      shape: record.report.shape,
      ...(record.report.diskFreeBytes !== undefined ? { diskFreeBytes: record.report.diskFreeBytes } : {}),
      engine: record.report.engine,
      ...(record.report.copies !== undefined ? { copies: record.report.copies } : {}),
      present: live.has(record.id),
      // The remove runs that computer's own `wsp leave`, which takes the folder only where its wsp is that new.
      ...(record.report.takesRuntime === true && leaveAsks(record.report) ? { takesRuntime: true } : {}),
      joinedAt: record.joinedAt,
      lastSeenAt: record.lastSeenAt,
      daemonVersion: record.report.daemonVersion,
      ...((): Pick<PlaceView, "behind"> => {
        const word = placeDaemonBehind(record.report);
        return word === undefined ? {} : { behind: { word, fix: placeUpdateLine(record.name), act: "update" } };
      })(),
      agents: record.report.agents,
      ...(record.report.agentVersions !== undefined ? { agentVersions: record.report.agentVersions } : {}),
      // One word per agent for whether a turn there needs a sign-in first, worked out from what that computer listed
      // under its logins folder and what this host's vault holds. Nothing from a daemon that lists neither.
      ...((): { signIns?: Record<string, AgentSignInState> } => {
        const words = signInsOf(record.report, opts.vault?.() ?? {});
        return words === undefined ? {} : { signIns: words };
      })(),
      ...(record.backendFacts?.logins !== undefined ? { logins: record.backendFacts.logins } : {}),
      // A joined computer boots the image or it never joined: the daemon's self check is the gate at the join, so
      // every computer on this list forks.
      takesForks: true,
      // Field by field rather than spread: the key file on the record is a path on this computer and no client's
      // business, and a road copied whole would hand it over.
      ...(record.road === undefined
        ? {}
        : { road: { ...(record.road.ssh !== undefined ? { ssh: record.road.ssh } : {}), ...(record.road.from !== undefined ? { from: record.road.from } : {}), ...(record.road.back !== undefined ? { back: record.road.back } : {}) } }),
      // The folder a turn there starts in and how long it had been up: read off the same report the system name is
      // read from, so a computer that stopped answering shows what it last was rather than nothing at all.
      ...(record.report.login["HOME"] !== undefined ? { home: record.report.login["HOME"] } : {}),
      ...(record.report.uptimeMs !== undefined ? { uptimeMs: record.report.uptimeMs } : {}),
      ...(record.reportedAt !== undefined ? { reportedAt: record.reportedAt } : {}),
      ...(record.dialled !== undefined ? { dialled: record.dialled } : {}),
      ...(blocked !== undefined ? { blocked } : {}),
      ...(toolsBlocked !== undefined ? { toolsBlocked } : {}),
      ...(record.setup !== undefined ? { setup: record.setup } : {}),
      ...(record.applied !== undefined ? { applied: appliedView(record.applied) } : {}),
      ...(record.picks !== undefined ? { picks: record.picks } : {}),
      ...(record.recipe !== undefined ? { recipe: record.recipe } : {}),
      ...(record.sync !== undefined ? { sync: record.sync } : {}),
    };
  };

  /** What a join has told this host before its prove: the key it will sign with and when it opened. The record is
   * written on the prove, so a join whose prove never arrives leaves nothing behind but this, and the next join
   * sweeps whatever stood past the wait. */
  const joining = new Map<string, { publicKey: string; at: number }>();

  /** The join's own half of the prove: the code is spent here, inside the seal and after this host has proved the
   * key the join line named, and the record is written only once all of it stood. */
  const joined = async (
    placeId: string,
    pending: { publicKey: string },
    req: PlaceProveRequest,
    expect: Uint8Array,
    from: string,
    at: number,
  ): Promise<{ report: PlaceReport; device?: { deviceId: string; deviceToken: string } } | { refusal: string }> => {
    joining.delete(placeId);
    if (!verifyPlaceBytes(pending.publicKey, expect, req.signature)) return { refusal: PLACE_KEY_REFUSAL };
    let taken: PlaceReport;
    try {
      taken = takenReport(req.report);
    } catch (e) {
      return { refusal: e instanceof Error ? e.message : String(e) };
    }
    // A computer that cannot boot the image is not a place: the daemon's own doctor says why in one sentence and
    // the join stops on it, before the code is spent and before a record exists.
    const blocked = placeBlocked(taken.name, taken);
    if (blocked !== undefined) return { refusal: blocked };
    if (req.code === undefined || !(await devices.spend(req.code, at))) return { refusal: PLACE_CODE_REFUSAL };
    const stamp = new Date(at).toISOString();
    // An install that handed this computer the code is waiting on the link it will open next; which place the
    // code became is noted before the first write of the record, so that write carries the road it came in over.
    const waiting = awaiting.get(req.code);
    if (waiting !== undefined) waiting.placeId = placeId;
    const record = await keep({ id: placeId, name: taken.name, publicKey: pending.publicKey, joinedAt: stamp, lastSeenAt: stamp, reportedAt: stamp, report: taken });
    // Last added is the default, which is what makes the computer somebody just joined the one a verb means.
    await markDefault(placeId);
    // One code buys the place and, when the app asked, the token the joining computer's own window holds: the
    // person's intent was one act. The socket stays the place link and is bound to no device.
    const client = req.client === undefined ? undefined : await devices.admit(req.client.name, at);
    emit({ type: "place.joined", place: viewOf(record, placeId), from });
    return { report: taken, ...(client === undefined ? {} : { device: { deviceId: client.deviceId, deviceToken: client.deviceToken } }) };
  };

  /** Takes a place off this host: its link, its record, the default it may be, and anyone waiting on its dial. */
  const forget = async (placeId: string): Promise<void> => {
    if (live.has(placeId)) cut(placeId, "removed from this host");
    backends.delete(placeId);
    await inRecordTurn(placeId, async () => {
      kept.delete(placeId);
      await store.delete(PLACES, placeId);
    });
    await store.delete(CAPS, placeId);
    settingsHeld.delete(placeId);
    await inTurn(async () => {
      if ((await defaultId()) === placeId) await store.delete(DEFAULT_COLLECTION, DEFAULT_ID);
    });
    woken(placeId, false);
    closedAt.delete(placeId);
    emit({ type: "place.removed", placeId });
  };

  /** The row of the computer the host runs on, off what it says about itself now. */
  const hereRow = (marked: string): PlaceView => {
    const here = wiring.here();
    const daemonVersion = opts.hereDaemon?.held?.();
    const behind = daemonVersion === undefined ? undefined : placeDaemonBehind({ daemonVersion });
    return {
      id: HERE_PLACE_ID,
      kind: "computer",
      name: here.name,
      ...(here.label !== undefined ? { label: here.label } : {}),
      ...(here.mac !== undefined ? { mac: here.mac } : {}),
      default: marked === HERE_PLACE_ID,
      ...(here.os !== undefined ? { os: here.os } : {}),
      ...(here.shape !== undefined ? { shape: here.shape } : {}),
      ...(here.diskFreeBytes !== undefined ? { diskFreeBytes: here.diskFreeBytes } : {}),
      ...(here.engine !== undefined ? { engine: here.engine } : {}),
      ...(daemonVersion !== undefined ? { daemonVersion } : {}),
      ...(behind !== undefined && opts.hereDaemon !== undefined ? { behind: { word: behind, fix: opts.hereDaemon.fix, act: "install" as const } } : {}),
      present: true,
      // This computer is where the person's own agents run, never something the host forks into: a copy of the
      // image on a runtime here is that place's own row, which is the one that says it forks.
      takesForks: false,
      buildsImages: false,
    };
  };
  /** This computer first, the computers joined to it after, the providers last, each with its cap; exactly one
   * default, which falls to this computer when the mark names a row that is no longer here. */
  const rowsOf = async (held: readonly PlaceRecord[]): Promise<PlaceView[]> => {
    const marked = (await markHeld()) ?? HERE_PLACE_ID;
    const rows: PlaceView[] = [hereRow(marked), ...held.map(r => joinedRow(r, marked)), ...providerIds().map(id => providerRow(id, marked))];
    return Promise.all(rows.map(row => withCap(row, rows)));
  };
  /** A joined computer's row off its record, less the fork room, which asks the computer itself. */
  const joinedRow = (record: PlaceRecord, marked: string): PlaceView => ({ ...viewOf(record, marked), ...imageFacts(record.id, ctx.door.backendOf(record.id)) });
  const providerRow = (id: string, marked: string): PlaceView => {
    const rate = providerRate(id);
    const sizes = providerSizes(id);
    return {
      id,
      kind: "provider",
      name: id,
      default: marked === id,
      takesForks: true,
      ...(rate !== undefined ? { rateUsdPerHour: rate } : {}),
      ...(sizes.length > 0 ? { sizes: [...sizes] } : {}),
      ...imageFacts(id, providerBackend(id)),
    };
  };

  return {
    pendingRecords, putPending, dropPending, flooring, floorOnce, takenBack, unmergedOver, pluginsOff, factsOn,
    backendFrom, tunnelled, cut, forksOf, viewOf, joining, joined, forget, hereRow, rowsOf, joinedRow, providerRow,
  };
}
export type PlaceViewsArea = ReturnType<typeof placeViews>;
