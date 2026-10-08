// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import {
  HERE_PLACE_ID,
  NO_PLACE_INSTALLER,
  NO_RECIPE,
  PAIR_CODE_TTL_MS,
  PLACE_LEAVE_LINE,
  DAEMON_VERSION,
  placeSetRefusal,
  placeRenameRefusal,
  placeSshRefusal,
  placeSshOtherRefusal,
  placeSshUncheckedRefusal,
  placeLoginOtherRefusal,
  placeLoginUncheckedRefusal,
  placeLoginElsewhere,
  placeLoginElsewhereRemovedLine,
  placeSettingDropped,
  PlaceSettings,
  joinToken,
  absentComputer,
  noSuchPlaceRefusal,
  placeHoldsForksRefusal,
  placeHoldsProjectsRefusal,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  placeStillInstalledLine,
  placeDialLine,
  placeDialRoad,
  placeNoPicksLine,
  placeProvisionPaths,
  placeSyncingLine,
  pluginsKeptLine,
  projectLeftLine,
  RecipeFile,
  recipeCounts,
  SETUP_LOG_TAIL_BYTES,
  SKIPPED_FOR_NOW,
  nothingToSkipLine,
  pendingHeldLine,
  pendingHeldFix,
  pendingNotJoinedLine,
  noPendingRefusal,
  pendingNotJoinedFix,
  CHOOSE_FIX,
  placeNoDialLine,
  type PlaceAddStep,
  PLACE_HOST_KEY_KIND,
  type PlaceStageEvent,
  withPlaceStage,
  keptSaid,
  markedCut,
  refusalParts,
  usageRefusal,
  type PlaceDialled,
  type PlaceBack,
  type PlaceUpdateReply,
  twoPlacesRefusal,
  linkedOver,
  shellQuote,
} from "@wsp/protocol";
import { ownedFloorBytes, PlaceAbsentError, PlaceMachine, keyFingerprint } from "@wsp/engine";
import { openPlaceForward } from "../place-forward.js";
import {
  CAPS, projectsMade, type PlaceLogin, type PlaceRecord, type PlaceStaging, type RecipeResolver, type PlaceDoor, NO_PLACE_UPDATER,
  placeUpdateSlowLine, placeSweptOverSshLine, placeLoginRoadLine, placeSweptOverLinkLine, placeElsewhereSweptOverLinkLine, PlaceLoginRefusedError, PlaceHostKeyChangedError,
  PlaceAddTakenBackError,
} from "./types.js";
import {
  bounded, JOIN_WAIT_MS, ADD_RUNNING_LINE, ADD_RUNNING_FIX, boxSaid, type PendingRecord, pendingView, setupOutcome,
  NO_ESTIMATE_LINE, LOG_READ_MS, UPDATE_WAIT_MS,
} from "./helpers.js";
import type { PlaceDoorContext } from "./context.js";
import type { PlaceRecordsArea } from "./records.js";
import type { PlaceSetupArea } from "./setup.js";
import type { PlaceViewsArea } from "./views.js";

/** The door's half a person drives: add, dial, update, remove, set up, follow a recipe and list the places. */
export function manageDoor(ctx: PlaceDoorContext, recordArea: PlaceRecordsArea, setupArea: PlaceSetupArea, viewArea: PlaceViewsArea): Pick<PlaceDoor, "add" | "dial" | "road" | "exec" | "adds" | "reportOf" | "homeOf" | "list" | "rows" | "set" | "update" | "remove" | "find" | "pending" | "choose" | "setUp" | "follow" | "recipeChanged" | "followers" | "skip" | "estimate" | "setupLog" | "unfollow" | "picksOf" | "on" | "close"> {
  const { opts, store, devices, wiring, recording, clockNow, dialWaitMs, live, kept, forwards, watchers, emit } = ctx;
  const {
    records, providerIds, recordOf, settingsOf, settingsHeld, rowIds, withCap, untilDaemonVersion, awaiting, adds,
    putAdd, loginOf, rootOver, loginAnswers, reachedOver, holdBack, defaultId, inTurn, markHeld, change,
  } = recordArea;
  const {
    waiting, woken, setting, syncing, skippers, settingNow, recipesMoved, syncFrame, setupFrame, startSetup,
    syncTimers, syncOf, markSync, syncSoon, startedOrSaid, linkTo,
  } = setupArea;
  const {
    pendingRecords, putPending, dropPending, floorOnce, unmergedOver, pluginsOff, factsOn, cut, forksOf, viewOf,
    joining, joined, forget, hereRow, rowsOf, joinedRow, providerRow,
  } = viewArea;

  /** A computer made to follow a recipe by slug, or none: one that follows none keeps what it has and is in step with
   * nothing, one that follows a recipe syncs to it. Answers the record as written. */
  const followTo = async (placeId: string, recipe: string): Promise<PlaceRecord | undefined> => {
    let before: PlaceRecord | undefined;
    const moved = await change(placeId, now => {
      before = now;
      const { sync: _behind, ...rest } = now;
      return recipe === NO_RECIPE ? { ...rest, recipe } : { ...now, recipe };
    });
    if (recipe === NO_RECIPE && before?.sync !== undefined) syncFrame({ placeId });
    if (recipe !== NO_RECIPE) syncSoon(placeId, 0);
    for (const slug of new Set([before?.recipe, recipe])) if (slug !== undefined && slug !== NO_RECIPE) recipesMoved(slug);
    return moved;
  };

  /** Reads a login as this computer before it is kept: the place file there, read over that login as root, names this
   * computer's id and this host's key. A computer that answers anything else, or holds no place file, is another
   * one; a login that will not stand, or a sudo that asks for a password, leaves it unread. Nothing is written. */
  const sameComputerOver = async (record: PlaceRecord, ssh: string): Promise<void> => {
    const login: PlaceLogin = { ssh, ...(record.road?.keyPath !== undefined ? { keyPath: record.road.keyPath } : {}) };
    const read = await reachedOver(record, login);
    const said = "unread" in read ? placeSshUncheckedRefusal(ssh, record.name, read.unread) : read.same ? undefined : placeSshOtherRefusal(ssh, record.name);
    if (said !== undefined) throw usageRefusal(said.happened, said.fix);
  };

  /** Holds a road over a computer's own login to that computer before anything of wsp's runs over it. Answers that
   * it stands, ssh's own line where the login itself would not stand (which reaches no machine at all), or where it
   * reaches another machine, by its record's name where that is another computer added here. A read that did not
   * run is refused by name, since nothing then says which machine answered. */
  const reachesItself = async (record: PlaceRecord, login: PlaceLogin, sudoPassword?: string): Promise<{ stands: true } | { refused: string } | { elsewhere: true; other?: string }> => {
    const read = await reachedOver(record, login, sudoPassword);
    if ("same" in read) return read.same ? { stands: true } : { elsewhere: true, ...(read.other !== undefined ? { other: read.other } : {}) };
    if (read.refused === true) return { refused: read.unread };
    const said = placeLoginUncheckedRefusal(login.ssh, record.name, read.unread);
    throw usageRefusal(said.happened, said.fix);
  };

  return {
    async add(req, at) {
      const install = wiring.install;
      if (install === undefined) throw new Error(NO_PLACE_INSTALLER);
      const addId = req.addId ?? `a_${randomBytes(6).toString("hex")}`;
      if (adds.get(addId)?.state === "running") throw usageRefusal(ADD_RUNNING_LINE, ADD_RUNNING_FIX);
      // One add per address: a second is refused while the first stands, joined and waiting on its choices
      // included. One that failed is this add's to take over.
      const before = (await pendingRecords()).filter(p => p.address === req.address);
      const standing = before.find(p => p.failed === undefined);
      if (standing !== undefined) throw usageRefusal(pendingHeldLine(req.address, standing.step), pendingHeldFix(standing.name ?? req.address));
      for (const p of before) await dropPending(p.id);
      // The add from its first step, so a host that stops in the middle of it finds it at its next start.
      let pending: PendingRecord = {
        id: addId,
        address: req.address,
        ...(req.sshPort !== undefined ? { sshPort: req.sshPort } : {}),
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.keyPath !== undefined ? { keyPath: req.keyPath } : {}),
        ...(req.hostKey !== undefined ? { hostKey: req.hostKey } : {}),
        step: "connect",
        choices: req.choices ?? RecipeFile.parse({ name: req.name ?? req.address }),
        ...(req.recipe !== undefined ? { recipe: req.recipe } : {}),
        startedAt: new Date(at).toISOString(),
      };
      let pendingWrites: Promise<void> = putPending(pending);
      const movePending = (next: PendingRecord): Promise<void> => {
        pending = next;
        pendingWrites = pendingWrites.then(() => putPending(next)).catch(() => undefined);
        return pendingWrites;
      };
      let step: PlaceAddStep = "connect";
      // The step the installer itself already marked failed, so the end of the add does not say it a second time.
      let failedSaid: PlaceAddStep | undefined;
      const stage: PlaceStaging = (which, state, note, placeId, ms) => {
        if (state === "running") step = which;
        if (state === "failed") failedSaid = which;
        if (state === "running" && which === "check") void movePending({ ...pending, step: "check" });
        const said: PlaceStageEvent = { type: "place.stage", addId, step: which, state, ...(note !== undefined ? { note } : {}), ...(placeId !== undefined ? { placeId } : {}), ...(ms !== undefined ? { ms } : {}) };
        putAdd(addId, job => withPlaceStage(job, said));
        opts.onStage?.(said);
      };
      const { code } = await devices.issue({ now: at, ttlMs: PAIR_CODE_TTL_MS });
      // Kept from here, where the catch below ends every add it starts: a job that never ends would read as running.
      adds.delete(addId);
      adds.set(addId, { addId, address: req.address, ...(req.sshPort !== undefined ? { sshPort: req.sshPort } : {}), startedAt: new Date(at).toISOString(), state: "running", steps: [] });
      const waiting: { placeId?: string; login?: PlaceLogin; back?: PlaceBack; woken?: (placeId: string) => void } = {};
      awaiting.set(code, waiting);
      let installing = true;
      try {
        const { addId: _stream, choices: _choices, recipe: _recipe, ...asked } = req;
        await pendingWrites;
        const installed = await install(
          {
            ...asked,
            code: joinToken(code, keyFingerprint(wiring.hostKey.publicKey)),
            // Written before a byte of wsp's is sent, with what takes the install back and the login that reaches it.
            beforeDeploy: (undo, ssh, hostKey) => movePending({ ...pending, step: "wsp", undo, login: ssh, ...(hostKey !== undefined ? { hostKey } : {}) }),
          },
          stage,
        );
        installing = false;
        // The road back to this computer is the host's the moment the install answers, and what the wait comes to
        // does not change it: the computer that most needs a login held here is the one whose agent never dials.
        // A join still to land carries it off this entry; one that already landed has its record written again.
        waiting.login = installed.ssh === undefined ? undefined : { ssh: installed.ssh, ...(installed.sshKeyPath !== undefined ? { keyPath: installed.sshKeyPath } : {}), ...(installed.hostKey !== undefined ? { hostKey: installed.hostKey } : {}) };
        if (installed.back !== undefined) waiting.back = installed.back;
        if (waiting.login !== undefined && waiting.placeId !== undefined) await change(waiting.placeId, now => now);
        const joining = Date.now();
        stage("join", "running");
        const placeId = await new Promise<string>((woken, fail) => {
          // The link may already be up: the computer dials the moment its own join has written its place file, and
          // that can land before the install's own ssh command has answered.
          if (waiting.placeId !== undefined && live.has(waiting.placeId)) {
            woken(waiting.placeId);
            return;
          }
          const timer = setTimeout(() => fail(new Error(placeNoLinkLine(installed.name))), opts.joinWaitMs ?? JOIN_WAIT_MS);
          timer.unref?.();
          waiting.woken = id => {
            clearTimeout(timer);
            woken(id);
          };
        }).catch(async (e: unknown) => {
          // The host still holds the road it installed over, and the agent on that computer has been writing why
          // its dial does not land every ten seconds. Its own sentence beats a person guessing at routes.
          throw new Error([e instanceof Error ? e.message : String(e), ...(await boxSaid(wiring, installed))].join("\n"));
        });
        const held = await recordOf(placeId);
        if (held === undefined) throw new Error(placeNoLinkLine(installed.name));
        holdBack(held);
        // The size the box reported is not here: every road that draws this line draws the box's row beside it, and
        // a fact already in the row costs the line the room it needs to read whole.
        stage("join", "done", [linkedOver(held.report.dialed, held.road?.back, req.hostUrls), `engine ${held.report.engine}`].filter(Boolean).join(", "), placeId, Date.now() - joining);
        // What that computer forks with, read over the link it has just opened and before this answers: the row a
        // join prints carries where that computer keeps the logins its workspaces share, which is what the
        // sign-in offered right after it reads. Waited for no longer than one frame on a fresh link takes: a
        // computer slower than that is joined all the same, its answer lands on the record behind this add, and
        // its row carries nothing about its forks until then, as every row did before any of this was asked.
        const facts = await factsOn(placeId, held);
        await pendingWrites;
        const hostKey = installed.hostKey !== undefined ? { hostKey: installed.hostKey } : {};
        // Nothing picked yet: the computer is pending at its choices, and the floor goes on while the person picks.
        if (req.choices === undefined) {
          const joined: PendingRecord = { ...pending, placeId, step: "floor" };
          await movePending(joined);
          void floorOnce(joined, placeId);
          return { addId, place: viewOf(facts, await defaultId()), ...hostKey, pending: pendingView(joined) };
        }
        // Picked: the setup starts before this answers and runs on behind it, its frames on the add's own stream.
        // Started rather than fired and forgotten, so the row this answers with says whether it is under way.
        await dropPending(pending.id);
        const started = await startedOrSaid(placeId, addId, { picks: req.choices, ...(req.recipe !== undefined ? { recipe: req.recipe } : {}) });
        const row = (await recordOf(placeId)) ?? facts;
        return { addId, place: viewOf(row, await defaultId()), ...hostKey, ...(started.said !== undefined ? { said: started.said } : {}) };
      } catch (e) {
        // The step the install was on when it stopped is the one that failed, so a person reads the sentence
        // against the line it belongs to rather than under the list. One line of it: a note is printed after the
        // step's own marker at a terminal and inside one span in the sheet, and what a failure says beyond its
        // first line rides the throw, which both roads print whole.
        const message = e instanceof Error ? e.message : String(e);
        const { said, fix, kind } = refusalParts(e);
        // The key a computer never dialled answered with rides its refusal as a field, kept for the client's Trust.
        const offered = kind === PLACE_HOST_KEY_KIND && typeof (e as { hostKey?: unknown }).hostKey === "string" ? { hostKey: (e as { hostKey: string }).hostKey } : {};
        putAdd(addId, job => ({ ...job, said: keptSaid(said), ...(fix === undefined ? {} : { fix }), ...(kind === undefined ? {} : { kind }), ...offered }));
        // The pending add keeps the refusal, so the computer reads Setup failed with what to do until it is added
        // again; an add that joined and then failed is that computer's row to say.
        if (pending.placeId === undefined) await movePending({ ...pending, failed: { said: keptSaid(said), ...(fix === undefined ? {} : { fix }) } });
        if (failedSaid !== step) stage(step, "failed", markedCut(message.split("\n")[0]!));
        // The code went to the box as a file, so an add that failed spends it rather than leave it good for ten minutes.
        await devices.spend(code, at).catch(() => false);
        // The install took its join back off the box, so the record that join made names a computer that no longer
        // carries it. One it could not take back keeps its record, which is the road a remove sweeps it by.
        if (installing && waiting.placeId !== undefined && e instanceof PlaceAddTakenBackError) await forget(waiting.placeId);
        // A forward stays held for as long as a record dials back through it, and goes with an add that left none.
        if (waiting.login !== undefined && waiting.back !== undefined) {
          const landed = waiting.placeId === undefined ? undefined : await recordOf(waiting.placeId);
          if (landed?.road?.back === undefined) wiring.back?.release(waiting.login);
          else holdBack(landed);
        }
        throw e;
      } finally {
        awaiting.delete(code);
      }
    },

    async dial(placeId, at) {
      const held = await recordOf(placeId);
      if (held === undefined) throw new Error(noSuchPlaceRefusal(placeId, [...kept.values()].map(r => r.name)));
      const stamp = new Date(at).toISOString();
      const linked = live.get(placeId)?.reach;
      const started = clockNow();
      const took = (): number => Math.max(0, Math.round(clockNow() - started));
      let dialled: PlaceDialled;
      // Which road there is, off the one reading of it the app also draws its button from: a road here and no
      // button there would be a press nobody could make, and a button there with no road here is one that answers
      // only that there was nowhere to dial. Both halves are taken off that one reading rather than asked again.
      const road = placeDialRoad({ present: linked !== undefined, road: held.road });
      const link = road === "link" ? linked : undefined;
      const ssh = road === "ssh" ? loginOf(held) : undefined;
      if (link !== undefined) {
        // The link's own heartbeat op: the cheapest frame that proves the computer at the other end is still
        // answering, rather than that this host is still holding a socket to it.
        try {
          await bounded(link.request("ping"), dialWaitMs, `ping on ${held.name}`);
          dialled = { at: stamp, answered: true, roundTripMs: took() };
        } catch (e) {
          dialled = { at: stamp, answered: false, said: e instanceof Error ? e.message : String(e) };
        }
      } else if (ssh !== undefined && wiring.dial !== undefined) {
        try {
          await bounded(wiring.dial(ssh), dialWaitMs, `ssh ${ssh.ssh}`);
          dialled = { at: stamp, answered: true, roundTripMs: took() };
        } catch (e) {
          dialled = { at: stamp, answered: false, said: e instanceof Error ? e.message : String(e) };
        }
      } else {
        dialled = { at: stamp, answered: false, said: placeNoDialLine(held.name) };
      }
      // A frame the computer itself answered is that computer heard from, so the silence is dated from it; an ssh
      // login that answered is the box speaking and not the agent, and it does not move that date.
      const seen = dialled.answered && linked !== undefined ? { lastSeenAt: stamp } : {};
      const moved = (await change(placeId, now => ({ ...now, dialled, ...seen }))) ?? { ...held, dialled, ...seen };
      return { dialled, line: placeDialLine({ name: held.name, road: held.road, linked: linked !== undefined, dialled }), place: await withCap(viewOf(moved, await defaultId()), await rowIds()) };
    },

    async road(placeId) {
      const held = live.get(placeId);
      const name = (await recordOf(placeId))?.name ?? placeId;
      if (held === undefined) throw new Error(absentComputer(name, null).sentence);
      const port = (await recordOf(placeId))?.report.daemonPort;
      if (port === undefined) throw new Error(placeNoDaemonPortLine(name));
      // One port per link, opened at the first pane that asks and closed with the link it rides.
      held.forward ??= openPlaceForward(held.reach, port);
      try {
        return (await held.forward).port;
      } catch (e) {
        if (live.get(placeId) === held) delete held.forward;
        throw e;
      }
    },

    async exec(placeId, cmd, execOpts) {
      const held = live.get(placeId);
      const absent = async (): Promise<PlaceAbsentError> => new PlaceAbsentError(absentComputer((await recordOf(placeId))?.name ?? placeId, null).sentence);
      if (held === undefined) throw await absent();
      let answer: Record<string, unknown>;
      try {
        answer = await held.reach.request("exec", {
          cmd,
          ...(execOpts.timeoutMs !== undefined ? { timeoutMs: execOpts.timeoutMs } : {}),
          ...(execOpts.stdin !== undefined ? { stdin: Buffer.from(execOpts.stdin).toString("base64") } : {}),
        });
      } catch (e) {
        // The socket it rode still open is the computer answering for itself; one that went is the link.
        const now = live.get(placeId);
        if (now?.reach === held.reach && now.socket.readyState === now.socket.OPEN) throw e;
        throw await absent();
      }
      return { exitCode: Number(answer["exitCode"] ?? -1), stdout: String(answer["stdout"] ?? ""), stderr: String(answer["stderr"] ?? "") };
    },

    adds: () => [...adds.values()],

    reportOf: async placeId => (await recordOf(placeId))?.report,
    homeOf: async placeId => (await recordOf(placeId))?.report.login["HOME"],

    async list() {
      const held = await records();
      const room = new Map(await Promise.all(held.map(async r => [r.id, await forksOf(r)] as const)));
      return (await rowsOf(held)).map(row => {
        const forks = room.get(row.id);
        return forks !== undefined ? { ...row, forks } : row;
      });
    },

    rows: async () => rowsOf(await records()),

    async set(placeId, set, reset = [], also = {}) {
      const marked = (await markHeld()) ?? HERE_PLACE_ID;
      const record = placeId === HERE_PLACE_ID ? undefined : await recordOf(placeId);
      const row = placeId === HERE_PLACE_ID ? hereRow(marked) : record !== undefined ? joinedRow(record, marked) : providerIds().includes(placeId) ? providerRow(placeId, marked) : undefined;
      if (row === undefined) throw Object.assign(new Error(noSuchPlaceRefusal(placeId, [wiring.here().name, ...(await records()).map(r => r.name), ...providerIds()])), { kind: "usage" });
      const renamed = also.name?.trim();
      const ssh = also.ssh?.trim();
      const { spawn, ...rest } = set;
      const given = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
      // A name, a login or a recipe alone names no setting and is not refused as a set of nothing.
      const settles = (renamed === undefined && ssh === undefined && also.recipe === undefined) || spawn !== undefined || Object.keys(given).length > 0 || reset.length > 0;
      const refused = settles ? placeSetRefusal(row, set, reset) : undefined;
      if (refused !== undefined) throw Object.assign(new Error(refused), { kind: "usage" });
      if (renamed !== undefined) {
        const others = [hereRow(marked), ...(await records()).map(r => joinedRow(r, marked)), ...providerIds().map(id => providerRow(id, marked))];
        const misnamed = placeRenameRefusal(row, renamed, others);
        if (misnamed !== undefined) throw usageRefusal(misnamed.happened, misnamed.fix);
      }
      if (ssh !== undefined) {
        const wrong = placeSshRefusal(row, ssh);
        if (wrong !== undefined) throw usageRefusal(wrong.happened, wrong.fix);
      }
      // Only a computer this host keeps a record of follows a recipe, as places.follow says.
      if (also.recipe !== undefined && record === undefined) throw Object.assign(new Error(noSuchPlaceRefusal(placeId, (await records()).map(r => r.name))), { kind: "usage" });
      // The dial goes last, after every check that asks nothing of any computer, and before any write.
      if (ssh !== undefined && record !== undefined && ssh !== loginOf(record)?.ssh) await sameComputerOver(record, ssh);
      if (settles) {
        // Read and written in one turn, so two settings made at once on one place both stand.
        await inTurn(async () => {
          const held = await settingsOf(placeId);
          // The switch is a patch over the parts the place holds, and only the parts named are stored, so a cap named
          // alone keeps it on or off and every part nobody named follows the default as it reads now.
          const switched = spawn === undefined ? {} : { spawn: { ...held.spawn, ...spawn } };
          const next = reset.reduce<PlaceSettings>((at, word) => placeSettingDropped(at, word), { ...held, ...given, ...switched });
          await (Object.keys(next).length === 0 ? store.delete(CAPS, placeId) : store.put(CAPS, placeId, next));
          settingsHeld.set(placeId, next);
        });
      }
      if (set.napMs !== undefined || reset.includes("nap")) opts.napChanged?.(placeId);
      const was = record === undefined ? undefined : loginOf(record);
      let moved = renamed === undefined && ssh === undefined ? undefined : await change(placeId, now => ({ ...now, ...(renamed !== undefined ? { name: renamed } : {}), ...(ssh !== undefined ? { road: { ...now.road, ssh } } : {}) }));
      // An add still waiting on its picks lists the computer by the name it holds, and a resume finds it by that name.
      if (moved !== undefined && renamed !== undefined) for (const pending of await pendingRecords()) if (pending.placeId === placeId) await putPending({ ...pending, name: moved.name });
      // The forward a box dials back through rides the login: the old one lets it go unless another record holds it,
      // and the new one holds it from now.
      if (moved !== undefined && was !== undefined && was.ssh !== ssh && ssh !== undefined && moved.road?.back !== undefined) {
        if (!(await records()).some(r => r.id !== placeId && loginOf(r)?.ssh === was.ssh)) wiring.back?.release(was);
        holdBack(moved);
      }
      if (also.recipe !== undefined) moved = (await followTo(placeId, also.recipe)) ?? moved;
      const place = await withCap(moved === undefined ? row : joinedRow(moved, marked), await rowIds());
      emit({ type: "place.changed", place });
      return { place };
    },

    async update(placeId, ask = {}) {
      const held = await recordOf(placeId);
      if (held === undefined) throw new Error(noSuchPlaceRefusal(placeId, (await records()).map(r => r.name)));
      // Read before anything: another setup on that computer is refused as the op's own refusal, so whoever asked
      // reads one sentence and the line returns rather than following a job it did not start.
      const busy = setting.has(held.id) ? settingNow(held) : undefined;
      if (busy !== undefined) throw Object.assign(new Error(busy), { kind: "conflict" });
      // A daemon moved under a sync restarts the agent and cuts the link the sync installs over.
      if (syncing.has(held.id)) throw Object.assign(new Error(placeSyncingLine(held.name)), { kind: "conflict" });
      const from = held.report.daemonVersion;
      // A binary goes only where that computer is behind: a computer already running this wsp's daemon is the
      // common case for a recipe that changed, and the recipe half below is what the person asked for.
      const moving = from < DAEMON_VERSION;
      let daemon: PlaceUpdateReply["daemon"];
      if (wiring.update === undefined) {
        // A runtime outside the app and the host wires none, so nothing there writes the login files either; a
        // computer that needs a daemon it cannot be given is the one refusal.
        if (moving) throw new Error(NO_PLACE_UPDATER);
      } else {
        const link = live.get(placeId)?.reach;
        const ssh = loginOf(held);
        // The ssh road runs only where there is no link, and runs as root: where the login's sudo asks for a
        // password, it is asked for before anything goes there, as the add asks it.
        const sudoPassword = link === undefined && ssh !== undefined ? await rootOver(ssh, ask.sudoPassword, { verb: "update", name: held.name }) : undefined;
        if (link === undefined && ssh !== undefined) {
          const reached = await reachesItself(held, ssh, sudoPassword);
          if ("refused" in reached) throw new PlaceLoginRefusedError(reached.refused);
          if ("elsewhere" in reached) {
            const said = placeLoginOtherRefusal(ssh.ssh, held, reached.other);
            throw usageRefusal(said.happened, said.fix);
          }
        }
        // Asked on every update, behind or not: wsp's login files on that computer are spelled by this host, so a
        // host that moved alone writes them here and a computer joined under an older spelling takes this one.
        const landed = await wiring.update({
          placeId,
          name: held.name,
          report: held.report,
          daemon: moving,
          ...(link === undefined ? {} : { link }),
          ...(ssh === undefined ? {} : { ssh }),
          ...(sudoPassword === undefined ? {} : { sudoPassword }),
        });
        if (landed !== undefined) {
          // The row is the answer, not the landing: the computer restarts its agent and dials back, and what it says
          // about itself then is the only reading that proves the new daemon is the one running there.
          const to = await untilDaemonVersion(placeId, from, opts.updateWaitMs ?? UPDATE_WAIT_MS);
          // The attach on the new daemon dropped what the old one said it forks with and asked again; this waits for
          // that answer, so the row after an update carries the new daemon's facts rather than nothing while they are
          // still in flight. It joins the read behind the attach instead of sending a second frame.
          if (to !== from) await factsOn(placeId, held);
          daemon = {
            ...landed,
            from,
            to,
            ...(to >= DAEMON_VERSION ? {} : { note: placeUpdateSlowLine(held.name, Math.round((opts.updateWaitMs ?? UPDATE_WAIT_MS) / 1000)) }),
          };
        }
      }
      // A setup run again from the picks installs every row once more, which on a box that runs other things is
      // its disk and its cores for nothing (spoo filled its disk this way, 2026-10-04); a sync moves only the rows
      // that changed.
      if (held.recipe !== undefined && held.recipe !== NO_RECIPE) syncSoon(placeId, 0);
      return { name: held.name, ...(daemon === undefined ? {} : { daemon }) };
    },

    async remove(placeId, ask = {}) {
      const held = await recordOf(placeId);
      if (held === undefined) return { removed: false, swept: [] };
      // The forks on it are wsp's own machines and the person's to delete: a place taken out from under them would
      // leave containers on that computer nothing here can name again.
      const forks = await recording.forksOn(placeId);
      if (forks.length > 0) throw new Error(placeHoldsForksRefusal(held.name, forks));
      // A project is one computer's: taken out from under its projects, the place id on each record would name
      // nothing. The forks are refused first, since a workspace of a project is a machine standing on this place.
      // The projects the recipe's folders step made there are wsp's own and go with it; any other refuses.
      const made = projectsMade(held);
      const projects = await recording.projectsOn(placeId);
      const theirs = projects.filter(p => !made.has(p.id)).map(p => p.name);
      if (theirs.length > 0) throw new Error(placeHoldsProjectsRefusal(held.name, theirs));
      const reach = live.get(placeId)?.reach;
      const leaver = wiring.leave;
      const login = loginOf(held);
      const answers = leaver !== undefined && login !== undefined && (await loginAnswers(login));
      // The leave runs as root, and a login whose sudo asks for a password is asked for it before anything here
      // touches that computer, as the add asks it: a sweep over the link alone leaves the service behind.
      // A key other than the one the add kept is a machine that is not this computer, or one rebuilt with wsp gone
      // from it: no password goes there and nothing runs, as for a place file naming another computer.
      let keyChanged = false;
      const sudoPassword = answers
        ? await rootOver(login!, ask.sudoPassword, { verb: "remove", name: held.name }).catch((e: unknown) => {
            if (!(e instanceof PlaceHostKeyChangedError)) throw e;
            keyChanged = true;
            return undefined;
          })
        : undefined;
      // Root is reachable now, so the place file is read before the plugins or the leave run over that login: a login
      // repointed at another machine would run both there as root. Such a login runs nothing and the record goes all
      // the same, or a failed add tried again would leave a record nothing could take away.
      const reached = keyChanged ? { elsewhere: true as const } : answers ? await reachesItself(held, login!, sudoPassword) : undefined;
      const stands = reached !== undefined && "stands" in reached;
      const elsewhere = reached !== undefined && "elsewhere" in reached ? reached : undefined;
      const away = elsewhere === undefined ? undefined : placeLoginElsewhere(login!.ssh, held.name, elsewhere.other);
      // Before either road sweeps: a plugin comes off by its agent's own command, which may sit in the install folder
      // the sweep takes, and nothing on that computer knows which plugins were wsp's.
      const plugins = await pluginsOff(placeId, held, reach !== undefined, stands ? login : undefined, sudoPassword);
      let swept: string[] = [];
      let note: string | undefined;
      // What the road that logs in did where it did not finish the job, for the lines about the road that followed.
      let loginRoad: { at: string; said?: string } | undefined;
      // The leave that computer already carries, run over the login the install used, is the road a remove takes
      // wherever this host holds one, link or no link: it stops the service holding the agent up before the files
      // go, and what answers over the link cannot. Running it there rather than spelling it here is what keeps one
      // copy of the sweep.
      if (leaver !== undefined && login !== undefined) {
        if (!stands) {
          // The login did not stand, so nothing ran on that computer at all.
          loginRoad = { at: login.ssh };
        } else {
          try {
            swept = [...(await leaver({ placeId, name: held.name, report: held.report, ssh: login, ...(sudoPassword === undefined ? {} : { sudoPassword }) }))];
            note = placeSweptOverSshLine(held.name);
          } catch (e) {
            // Two different things, and the line a person reads says which: the login would not stand, or that
            // computer took the leave, ran it and stopped, whose own last words ride with it.
            loginRoad = { at: login.ssh, ...(e instanceof PlaceLoginRefusedError ? {} : { said: e instanceof Error ? e.message : String(e) }) };
          }
        }
      }
      // Either that login was never there to take or it did not finish the job, which leaves the two roads there
      // always were: the place's own sweep over the link, and the sentence for a computer nothing here reaches.
      if (note === undefined) {
        if (away !== undefined) note = reach === undefined ? placeLoginElsewhereRemovedLine(login!.ssh, held.name, elsewhere?.other) : placeElsewhereSweptOverLinkLine(held.name, away);
        if (reach === undefined) {
          note ??= loginRoad?.said === undefined ? placeStillInstalledLine(held.name) : `${placeLoginRoadLine(held.name, loginRoad.at, loginRoad.said)}; ${placeStillInstalledLine(held.name)}`;
        } else {
          try {
            // Before the folder holding the list goes with the leave: the servers wsp merged into the agents' own
            // files there are keys inside files that are theirs, which the daemon knows no format to take out.
            const took = await unmergedOver(placeId, held);
            const answer = await reach.request("place.leave");
            swept = [...took, ...(Array.isArray(answer["swept"]) ? (answer["swept"] as unknown[]).map(String) : [])];
            if (loginRoad !== undefined && away === undefined) note = placeSweptOverLinkLine(held.name, loginRoad.at, loginRoad.said);
          } catch (e) {
            const failed = `${held.name} was connected but did not finish the sweep: ${e instanceof Error ? e.message : String(e)}; run ${PLACE_LEAVE_LINE} on that computer`;
            const before = away !== undefined ? `${away}, so nothing was changed on the machine it reaches` : loginRoad === undefined ? undefined : placeLoginRoadLine(held.name, loginRoad.at, loginRoad.said);
            note = before === undefined ? failed : `${before}, and ${failed}`;
          }
        }
      }
      swept = [...plugins.off, ...swept];
      if (plugins.kept.length > 0) note = note === undefined ? pluginsKeptLine(held.name, plugins.kept) : `${note}; ${pluginsKeptLine(held.name, plugins.kept)}`;
      for (const project of projects) {
        const gone = await recording.removeFolder?.(placeId, project.id).then(
          () => projectLeftLine(project.name),
          () => undefined,
        );
        if (gone !== undefined) swept.push(gone);
      }
      if (reach !== undefined) cut(placeId, "removed from this host");
      // After the sweep, since the link that sweep may ride comes in through the forward.
      // Another record on the same login keeps it held: a failed add tried again leaves two, the live one among them.
      if (login !== undefined && held.road?.back !== undefined && !(await records()).some(r => r.id !== placeId && loginOf(r)?.ssh === login.ssh)) wiring.back?.release(login);
      for (const pending of await pendingRecords()) if (pending.placeId === placeId) await dropPending(pending.id);
      await forget(placeId);
      return { removed: true, swept, ...(note !== undefined ? { note } : {}) };
    },

    find: async ref => (await records()).filter(r => r.id === ref || r.name === ref),

    pending: async () => (await pendingRecords()).map(pendingView),

    async choose(ref, choices, recipe) {
      const pend = (await pendingRecords()).find(p => p.id === ref || p.address === ref || (p.placeId !== undefined && p.placeId === ref));
      if (pend === undefined) throw usageRefusal(noPendingRefusal(ref), "Run wsp computers to read the adds still pending.");
      const { recipe: _was, ...rest } = pend;
      const next: PendingRecord = { ...rest, choices, ...(recipe !== undefined ? { recipe } : {}) };
      await putPending(next);
      return pendingView(next);
    },

    async setUp(ref, o) {
      const addId = o.addId ?? `a_${randomBytes(6).toString("hex")}`;
      const held = await records();
      const pend = (await pendingRecords()).find(p => p.id === ref || p.address === ref || p.name === ref || (p.placeId !== undefined && (p.placeId === ref || kept.get(p.placeId)?.name === ref)));
      if (pend !== undefined && pend.placeId === undefined) throw usageRefusal(pendingNotJoinedLine(pend.name ?? pend.address), pendingNotJoinedFix(pend.address));
      const found = pend?.placeId !== undefined ? held.filter(r => r.id === pend.placeId) : held.filter(r => r.id === ref || r.name === ref);
      if (found.length > 1) throw usageRefusal(twoPlacesRefusal(ref, found.map(r => r.id)), "Name it by its id.");
      const record = found[0];
      if (record === undefined) throw usageRefusal(noSuchPlaceRefusal(ref, held.map(r => r.name)), "Run wsp computers to read the ones this host holds.");
      // A setup under way asked again with nothing new is followed rather than refused: the run it answers is the
      // one to read on to its next wait or its end. New picks are what a running setup refuses.
      if (setting.has(record.id) && record.setup !== undefined && o.choices === undefined && o.recipe === undefined) return { addId: record.setup.addId, place: viewOf(record, await defaultId()), setup: record.setup };
      // What it is set up with: the picks given, else the choices its pending add holds, else what it was set up
      // with before. A computer still choosing with nothing chosen waits on the person.
      const choices = o.choices ?? (pend !== undefined && Object.values(recipeCounts(pend.choices)).some(n => n > 0) ? pend.choices : undefined);
      if (choices === undefined && record.picks === undefined) throw usageRefusal(placeNoPicksLine(record.name), CHOOSE_FIX);
      if (pend !== undefined) await dropPending(pend.id);
      const recipe = o.recipe ?? (o.choices === undefined ? pend?.recipe : undefined);
      const started = await startSetup(record.id, addId, choices === undefined ? undefined : { picks: choices, ...(recipe !== undefined ? { recipe } : {}) });
      return { addId, place: viewOf((await recordOf(record.id)) ?? record, await defaultId()), ...started };
    },

    async follow(placeId, recipe) {
      const held = await recordOf(placeId);
      if (held === undefined) throw Object.assign(new Error(noSuchPlaceRefusal(placeId, (await records()).map(r => r.name))), { kind: "usage" });
      return viewOf((await followTo(placeId, recipe)) ?? held, await defaultId());
    },

    async recipeChanged(slug, afterMs = 0) {
      recipesMoved(slug);
      const names: string[] = [];
      // One read of the recipe for every computer that follows it.
      let resolved: Awaited<ReturnType<RecipeResolver["resolve"]>> | undefined;
      for (const r of await records()) {
        if (r.recipe !== slug) continue;
        resolved ??= await opts.recipes?.()?.resolve(slug).catch(() => undefined);
        const read = await syncOf(r, resolved);
        if (read === undefined || read.changes.length === 0) {
          if (read !== undefined) syncSoon(r.id, afterMs);
          continue;
        }
        names.push(r.name);
        if (!setting.has(r.id) && !syncing.has(r.id)) await markSync(r.id, { state: "behind", changes: read.changes.map(c => c.key), since: r.sync?.since ?? new Date(clockNow()).toISOString() });
        syncSoon(r.id, afterMs);
      }
      return names;
    },

    async followers() {
      const out = new Map<string, string[]>();
      for (const r of await records()) if (r.recipe !== undefined && r.recipe !== NO_RECIPE) (out.get(r.recipe) ?? out.set(r.recipe, []).get(r.recipe)!).push(r.name);
      return out;
    },

    async skip(placeId, row) {
      const held = await recordOf(placeId);
      if (held === undefined) throw usageRefusal(noSuchPlaceRefusal(placeId, (await records()).map(r => r.name)), "Run wsp computers to read the ones this host holds.");
      const live = skippers.get(`${placeId}/${row}`);
      if (live !== undefined) {
        await live();
      } else {
        const waits = held.setup?.waiting.some(w => w.row === row) === true;
        const failed = held.applied?.rows.find(r => r.id === row && r.outcome === "failed");
        if (!waits && failed === undefined) throw usageRefusal(nothingToSkipLine(row, held.name), "Skip a row the computer's page shows waiting or failed.");
        await change(placeId, now => {
          const failedNow = now.applied?.rows.find(r => r.id === row && r.outcome === "failed");
          const step = failedNow?.step ?? now.applied?.rows.find(r => r.id === row)?.step;
          const rows = [...(now.applied?.rows ?? []).filter(r => r.id !== row), { id: row, label: failedNow?.label ?? now.setup?.waiting.find(w => w.row === row)?.label ?? row, outcome: "skipped" as const, note: SKIPPED_FOR_NOW, ...(step !== undefined ? { step } : {}) }];
          return {
            ...now,
            ...(now.setup !== undefined ? { setup: { ...now.setup, waiting: now.setup.waiting.filter(w => w.row !== row) } } : {}),
            applied: { ...(now.applied ?? { hash: "", at: new Date(clockNow()).toISOString() }), rows },
          };
        });
        const now = await recordOf(placeId);
        if (now?.setup !== undefined && now.setup.state !== "running") setupFrame({ addId: now.setup.addId, placeId, ...setupOutcome(now.setup, now.applied) });
      }
      return viewOf((await recordOf(placeId))!, await defaultId());
    },

    async estimate(ref, choices) {
      const weigh = wiring.provision?.estimate;
      if (weigh === undefined) throw new Error(NO_ESTIMATE_LINE);
      const pend = (await pendingRecords()).find(p => p.id === ref || p.address === ref || p.name === ref || p.placeId === ref);
      const placeId = pend?.placeId ?? (await records()).find(r => r.id === ref || r.name === ref)?.id;
      const disk = placeId === undefined ? undefined : (await recordOf(placeId))?.report;
      const sized = await weigh(choices);
      // The install loop stops at the room it keeps free there, so the picks fit only above it.
      return { neededBytes: sized.bytes, keptBytes: ownedFloorBytes(disk?.diskSizeBytes), unmeasured: sized.unmeasured, ...(disk?.diskFreeBytes !== undefined ? { freeBytes: disk.diskFreeBytes } : {}) };
    },

    async setupLog(placeId, step) {
      const held = await recordOf(placeId);
      if (held === undefined) throw usageRefusal(noSuchPlaceRefusal(placeId, (await records()).map(r => r.name)), "Run wsp computers to read the ones this host holds.");
      const home = held.report.login["HOME"];
      if (home === undefined) return [];
      const machine = new PlaceMachine(linkTo(placeId), { id: held.name, home });
      const read = await machine.exec(`tail -c ${SETUP_LOG_TAIL_BYTES} ${shellQuote(placeProvisionPaths(home).log)} 2>/dev/null`, { timeoutMs: LOG_READ_MS });
      const lines = read.stdout.split("\n").filter(line => line !== "");
      // A read that filled its bytes started in the middle of a line, which is no line of the log.
      const whole = Buffer.byteLength(read.stdout) >= SETUP_LOG_TAIL_BYTES ? lines.slice(1) : lines;
      return step === undefined ? whole : whole.filter(line => line.includes(` [${step}] `));
    },

    async unfollow(slug) {
      const names: string[] = [];
      for (const r of await records()) {
        if (r.recipe !== slug) continue;
        if ((await change(r.id, now => (now.recipe === slug ? { ...now, recipe: NO_RECIPE } : undefined))) !== undefined) names.push(r.name);
      }
      recipesMoved(slug);
      return names;
    },

    picksOf: async placeId => (await recordOf(placeId))?.picks,

    on: fn => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },

    close: async () => {
      for (const timer of syncTimers.values()) clearTimeout(timer);
      syncTimers.clear();
      wiring.back?.close();
      for (const placeId of [...live.keys()]) cut(placeId, "this host is stopping");
      for (const placeId of [...waiting.keys()]) woken(placeId, false);
      for (const [key, f] of forwards) {
        for (const conn of f.conns.values()) conn.destroy();
        f.conns.clear();
        f.server.close();
        forwards.delete(key);
      }
      awaiting.clear();
    },
  };
}
