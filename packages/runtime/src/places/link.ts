// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import {
  LOOPBACK,
  HERE_PLACE_ID,
  NO_RECIPE,
  PLACE_KEY_REFUSAL,
  PLACE_UNKNOWN_REFUSAL,
  placeCapOf,
  placeTurnLimit,
  absentComputer,
  namesPlace,
  noSuchPlaceRefusal,
  placeForksNowhereLine,
  BackendFacts,
  type DaemonResponse,
  type PlaceReport,
  PLACE_UNSEALED_JOIN_REFUSAL,
  twoPlacesRefusal,
  placeBehindLine,
  placeDaemonBehind,
  SIGNED_IN_THERE,
  copiedFromLine,
  GITHUB_CLI,
  GITHUB_ROW,
  signInRowId,
  RecipeFile,
  type PlaceProvisionRow,
} from "@wsp/protocol";
import { LinkBackend, PlaceAbsentError, PlaceFolderMachine, PlaceMachine, keyFingerprint, newSetupRun } from "@wsp/engine";
import { connectDaemon } from "../reach.js";
import { verifyPlaceBytes } from "@wsp/keys";
import { CAPS, DEFAULT_COLLECTION, DEFAULT_ID, type PlaceRecord, type PlaceDoor, PlaceForksNowhereError, PlaceProvisioningError } from "./types.js";
import { vaultSignIn, landedOn, type LandedRow, bounded, readsAsEd25519, JOIN_PROVE_MS, PLACE_BAD_KEY_REFUSAL, takenReport, REPLACED, BACKEND_FACTS_MS } from "./helpers.js";
import { panePorts } from "./pane-ports.js";
import type { PlaceDoorContext } from "./context.js";
import type { PlaceRecordsArea } from "./records.js";
import type { PlaceSetupArea } from "./setup.js";
import type { PlaceViewsArea } from "./views.js";

/** The door's half that joins, proves and holds each computer's link, and answers what a link and a place say. */
export function linkDoor(ctx: PlaceDoorContext, recordArea: PlaceRecordsArea, setupArea: PlaceSetupArea, viewArea: PlaceViewsArea): Pick<PlaceDoor, "answerChallenge" | "join" | "auth" | "hostKey" | "prove" | "attach" | "link" | "channel" | "load" | "nameOf" | "settingsAt" | "turnLimitAt" | "threadsAt" | "signInsAt" | "githubFromVault" | "loginLanded" | "keyLanded" | "ghThere" | "offerOf" | "backendOf" | "forkingBackend" | "joined" | "folderComputer" | "forward" | "paneForwards" | "placeFor" | "defaultPlace" | "markUsed" | "markDefaultIfNone"> {
  const { opts, store, wiring, clockNow, seenEveryMs, live, kept, signInsHere, backends, forwards, asking, emit } = ctx;
  const panes = panePorts({ forwards, now: clockNow, schedule: ctx.schedule });
  const {
    records, wiredProvider, providerIds, providerBackend, recordOf, settingsOf, settingsHeld, awaiting, holdBack,
    defaultId, inTurn, markDefault, markHeld, challenge, signedRefusal, writeSeen, change, withCap, rowIds, loginListed,
  } = recordArea;
  const { channels, waiting, closedAt, woken, setting, settingNow, foldersOf, syncSoon, startedOrSaid, linkTo, landers, here } = setupArea;
  const folderMachines = new Map<string, { key: string; machine: PlaceFolderMachine }>();
  const { pendingRecords, putPending, flooring, floorOnce, takenBack, backendFrom, tunnelled, cut, joining, joined, forget, joinedRow } = viewArea;
  let tunnelSeq = 0;

  /** A sign-in finished outside the setup lands the setup's own row for it, one set aside or failed, under the label
   * it had. A setup or a sync still writing that computer's rows lands it among them, since it writes them over the
   * record whole. */
  const landSignIn = async (placeId: string, row: LandedRow): Promise<void> => {
    const run = landers.get(placeId);
    let landed = false;
    const moved =
      run !== undefined
        ? (landed = await run(row))
          ? await recordOf(placeId)
          : undefined
        : await change(placeId, now => {
            if (now.applied === undefined) return undefined;
            const rows = landedOn(now.applied.rows, row);
            if (rows === undefined) return undefined;
            landed = true;
            return { ...now, applied: { ...now.applied, rows } };
          });
    if (moved !== undefined && landed) emit({ type: "place.changed", place: await withCap(joinedRow(moved, (await markHeld()) ?? HERE_PLACE_ID), await rowIds()) });
  };

  return {
    answerChallenge: challenge,

    async join(req, _from, at) {
      // The key is read before anything else: a frame that names no key this host can hold is a join that was
      // never going to stand, and nothing of the person's has crossed yet either way.
      if (!readsAsEd25519(req.publicKey)) throw new Error(PLACE_BAD_KEY_REFUSAL);
      // Eight bytes: the id keys the store, so two places that drew the same one would be one record and the older
      // computer's link would replace the newer's on every dial.
      const id = `p_${randomBytes(8).toString("hex")}`;
      const opened = challenge(id, req.nonce, req.ephemeral);
      if (opened === undefined) throw new Error(PLACE_UNSEALED_JOIN_REFUSAL);
      // Nothing is written and no code is spent until the prove: the code, the report and the window this
      // computer wants ride inside the seal, after this host has proved the key the join line named.
      for (const [waiting, held] of joining) if (at - held.at > JOIN_PROVE_MS) joining.delete(waiting);
      joining.set(id, { publicKey: req.publicKey, at });
      return {
        reply: { placeId: id, hostPublicKey: opened.hostPublicKey, nonce: opened.nonce, signature: opened.signature, ephemeral: opened.ephemeral, hostName: wiring.hostName() },
        expect: opened.expect,
        seal: opened.seal,
      };
    },

    async auth(req) {
      const held = await recordOf(req.placeId);
      // The sentence signed before it is sent: the key is this host's own and the place pinned it at join, so
      // this host can give its word on a place it holds nothing of, which is the whole of what the refusal says.
      if (held === undefined) {
        return { refusal: PLACE_UNKNOWN_REFUSAL, signed: signedRefusal(req.placeId, req.nonce, PLACE_UNKNOWN_REFUSAL) };
      }
      const opened = challenge(req.placeId, req.nonce, req.ephemeral);
      // A daemon older than the seal agrees no key: the row already says it is behind and why, and that is the
      // sentence its link is refused with rather than one about a field.
      if (opened === undefined) throw new Error(placeBehindLine(held.name, placeDaemonBehind(held.report) ?? ""));
      return { reply: { nonce: opened.nonce, hostPublicKey: opened.hostPublicKey, signature: opened.signature, ephemeral: opened.ephemeral }, expect: opened.expect, seal: opened.seal };
    },

    hostKey() {
      return keyFingerprint(wiring.hostKey.publicKey);
    },

    async prove(placeId, req, expect, from, at) {
      const pending = joining.get(placeId);
      if (pending !== undefined) return joined(placeId, pending, req, expect, from, at);
      const held = await recordOf(placeId);
      if (held === undefined || !verifyPlaceBytes(held.publicKey, expect, req.signature)) return { refusal: PLACE_KEY_REFUSAL };
      const report = req.report;
      // The report on this frame is the one the record takes, on a join's second frame and on every relink alike,
      // so it is read by the same rule the join's own frame was.
      let taken: PlaceReport;
      try {
        taken = takenReport(report);
      } catch (e) {
        return { refusal: e instanceof Error ? e.message : String(e) };
      }
      return { report: taken };
    },

    async attach(placeId, socket, report, from, at, seal) {
      // A second link replaces the first: a laptop that slept and came back dials before the host has noticed the
      // old socket is a connection to nothing.
      cut(placeId, REPLACED);
      const held = await recordOf(placeId);
      if (held === undefined) {
        socket.close(1000, "this host no longer holds that place");
        return;
      }
      // Where the link dialled in from is the only address this host has for a computer that joined with a code,
      // so it is kept rather than only announced on the event. What the last dial of this computer said goes with
      // the link that arrived: the computer is here now, and a refusal from before it came back is not news.
      // The name is the one this computer joined under and is never taken off a report again: a box whose own
      // place file a hostile process edited would otherwise answer to another computer's name and take its
      // creates, its checkout and the keys of the turns that run there.
      // What a computer forks with belongs to the daemon that said it: one that dialled back on another version
      // is asked again rather than read off an answer the version before it gave, since a newer daemon can carry
      // a field the older one never did and an older one can have lost it. The read is the attach's own, below.
      let newDaemon = false;
      const moved = await change(placeId, now => {
        const next: PlaceRecord = { ...now, report, lastSeenAt: new Date(at).toISOString(), reportedAt: new Date(at).toISOString(), road: { ...now.road, from }, dialled: undefined };
        newDaemon = now.report.daemonVersion !== report.daemonVersion;
        if (newDaemon) delete next.backendFacts;
        return next;
      });
      if (moved === undefined) {
        socket.close(1000, "this host no longer holds that place");
        return;
      }
      if (newDaemon) {
        backends.delete(placeId);
        asking.delete(placeId);
      }
      const reach = connectDaemon({
        socket,
        ...(seal === undefined ? {} : { seal }),
        onEvent: e => {
          // A tunnel's bytes belong to the connection riding the forward that opened it and to nothing else on
          // this host: the road a fork's daemon is reached by reads its own frames, the pane's road reads the
          // rest, and neither is pushed at every watcher of the place.
          if (tunnelled(placeId, e)) return;
          void live.get(placeId)?.forward?.then(f => f.event(e)).catch(() => undefined);
          for (const read of channels.get(placeId) ?? []) read(e as unknown as Record<string, unknown>);
          opts.onDaemonEvent?.(placeId, e);
        },
      });
      const seen = setInterval(() => void writeSeen(placeId, clockNow()).catch(() => undefined), seenEveryMs);
      // The poller must not hold a host that is otherwise done open.
      seen.unref?.();
      live.set(placeId, { socket, reach, seen });
      // Before anything else this attach does: a request held over the gap is sent again on this socket, and the
      // stage waiting on it was told to wait rather than told the computer was gone.
      woken(placeId, true);
      // What the computer forks with is asked behind the attach and not in front of it, so the link is held whether
      // or not that answer comes and the first listing after a join carries the room it has left.
      // A computer whose recipe is running has said nothing wrong: that job's own end asks again, so the read is
      // quiet about it rather than logging a computer that would not say.
      void ctx.door.forkingBackend(placeId).catch((e: unknown) => {
        if (e instanceof PlaceProvisioningError) return;
        console.warn(`${moved.name} did not say what it forks with: ${e instanceof Error ? e.message : String(e)}`);
      });
      socket.once("close", () => {
        const mine = live.get(placeId);
        if (mine?.socket !== socket) return;
        live.delete(placeId);
        closedAt.set(placeId, Date.now());
        clearInterval(seen);
        // The port this host opened for that computer's panes goes with the link that carried them: a listener
        // left standing would answer a pane with a connection to nothing.
        void mine.forward?.then(f => f.close()).catch(() => undefined);
        reach.close();
        void writeSeen(placeId, clockNow()).catch(() => undefined);
        emit({ type: "place.absent", placeId });
      });
      emit({ type: "place.present", placeId, from });
      // Not taken off the list here: the join's own socket attaches and closes before the agent's link dials, and
      // an install that has not reached its wait yet would otherwise never be woken by the link that follows.
      for (const waiting of awaiting.values()) {
        if (waiting.placeId === placeId) waiting.woken?.(placeId);
      }
      // A setup a stopped host or a dropped link left running picks up where it was, and the floor of an add that
      // joined before the host stopped goes on, now that the computer can be reached.
      const current = await recordOf(placeId);
      if (current?.setup?.state === "running" && !setting.has(placeId)) void startedOrSaid(placeId, current.setup.addId);
      // A computer that follows a recipe catches up on what changed while it was away, or since this host started.
      else if (current?.recipe !== undefined && current.recipe !== NO_RECIPE && current.setup?.state === "done") syncSoon(placeId, 0);
      for (const pending of await pendingRecords()) if (pending.placeId === placeId && pending.step === "floor" && !flooring.has(pending.id)) void floorOnce(pending, placeId);
    },

    link: placeId => live.get(placeId)?.reach,

    channel(placeId, onEvent) {
      const held = live.get(placeId);
      if (held === undefined) return undefined;
      const reading = channels.get(placeId) ?? new Set<(event: Record<string, unknown>) => void>();
      channels.set(placeId, reading);
      reading.add(onEvent);
      let end: (gone: { code: number; reason: string }) => void = () => {};
      const closed = new Promise<{ code: number; reason: string }>(r => (end = r));
      // The link going away ends the channel, as a daemon socket closing ends the host's own: whatever was
      // running behind it on that computer is no longer something this host can read or stop. The listener comes
      // off with the channel, so a road that opens and closes many never piles them on one socket.
      const gone = (code: number, reason: Buffer): void => {
        forget();
        end({ code, reason: reason.toString("utf8") });
      };
      const forget = (): void => {
        reading.delete(onEvent);
        if (reading.size === 0) channels.delete(placeId);
        held.socket.off("close", gone);
      };
      held.socket.once("close", gone);
      return {
        send: frame => {
          const { op, ...params } = frame;
          const on = live.get(placeId);
          if (on?.reach !== held.reach) return Promise.reject(new PlaceAbsentError(absentComputer(kept.get(placeId)?.name ?? placeId, null).sentence));
          return on.reach.request(op, params) as Promise<DaemonResponse>;
        },
        closed,
        close: () => {
          forget();
          end({ code: 1000, reason: "closed here" });
        },
      };
    },

    async load() {
      for (const placeId of await store.keys(CAPS)) settingsHeld.set(placeId, await settingsOf(placeId));
      for (const record of await records()) {
        kept.set(record.id, record);
        if (record.backendFacts !== undefined && !backends.has(record.id)) backendFrom(record.id, record.backendFacts);
        holdBack(record);
        // A sign-in a setup that ended left waiting had its login in the host that stopped, so nothing follows it
        // now: it reads expired, and Retry asks for a fresh one. A running setup's waits run again as it resumes.
        if (record.setup !== undefined && record.setup.state !== "running" && record.setup.waiting.some(w => w.state === "waiting"))
          await change(record.id, now => (now.setup === undefined ? undefined : { ...now, setup: { ...now.setup, waiting: now.setup.waiting.map(w => ({ ...w, state: "expired" as const })) } }));
        // A sync the stopped host was running puts nothing on now: it is behind until the computer dials back.
        if (record.sync?.state === "running") await change(record.id, now => (now.sync?.state !== "running" ? undefined : { ...now, sync: { ...now.sync, state: "behind" } }));
      }
      // A setup left running resumes at its computer's next link (attach); an add the host stopped in the middle of
      // installing wsp either joined meanwhile, which is the join it was waiting on, or is taken back off that computer.
      for (const pending of await pendingRecords()) {
        if (pending.step !== "wsp" || pending.placeId !== undefined || pending.failed !== undefined) continue;
        const joined = pending.login === undefined ? undefined : [...kept.values()].find(r => r.road?.ssh === pending.login);
        if (joined !== undefined) {
          await putPending({ ...pending, placeId: joined.id, step: "floor" });
          continue;
        }
        void takenBack(pending);
      }
    },

    nameOf: placeId => (placeId === HERE_PLACE_ID ? wiring.here().name : (kept.get(placeId)?.name ?? placeId)),

    settingsAt: placeId => settingsHeld.get(placeId) ?? {},

    turnLimitAt: placeId => {
      const kind = placeId === HERE_PLACE_ID || kept.has(placeId) ? "computer" : providerIds().includes(placeId) ? "provider" : undefined;
      return kind === undefined ? undefined : placeTurnLimit(kind, settingsHeld.get(placeId) ?? {});
    },

    threadsAt: placeId => {
      if (placeId !== HERE_PLACE_ID && !kept.has(placeId)) return undefined;
      const shape = placeId === HERE_PLACE_ID ? wiring.here().shape : kept.get(placeId)?.report.shape;
      const cap = placeCapOf({ kind: "computer", ...(shape !== undefined ? { shape } : {}) }, settingsHeld.get(placeId) ?? {});
      return cap !== undefined && "threads" in cap ? cap.threads : undefined;
    },

    signInsAt: signInsHere,

    githubFromVault(placeId) {
      const held = kept.get(placeId);
      const github = held?.picks?.configs.github;
      return github !== undefined && (github.signin ?? "vault") === "vault" && held?.applied?.rows.some(r => r.id === GITHUB_ROW && r.outcome === "present") === true;
    },

    async loginLanded(placeId, agent) {
      await loginListed(placeId, agent);
      await landSignIn(placeId, { id: agent === GITHUB_CLI ? GITHUB_ROW : signInRowId(agent), outcome: "installed", note: SIGNED_IN_THERE });
    },

    async keyLanded(agent) {
      if (vaultSignIn(agent, opts.vault?.() ?? {}) !== "vault-key") return;
      for (const record of await records()) await landSignIn(record.id, { id: signInRowId(agent), outcome: "present", note: copiedFromLine(here()) });
    },

    async ghThere(placeId, stage) {
      const provisioner = wiring.provision;
      const record = await recordOf(placeId);
      const home = record?.report.login["HOME"];
      if (provisioner === undefined || record === undefined || home === undefined) return [];
      // The GitHub step's own road, planned alone: picks naming gh among their CLIs plan it there instead.
      const picks = { ...(record.picks ?? RecipeFile.parse({ name: record.name })), clis: {}, configs: { github: { signin: "machine" as const } } };
      const plan = await provisioner.setup(picks, { home }, new Set(["github"]));
      const rows = await provisioner.step(new PlaceMachine(linkTo(placeId), { id: record.name, home }), plan, "github", newSetupRun(), stage, { home });
      // On the record as the setup's own gh would be, so the undo of a recipe that drops GitHub takes it off again; the
      // engine stamps no step, and a later run keeps only the rows of the steps that ended.
      for (const row of rows) if (row.outcome === "installed") await landSignIn(placeId, { ...row, step: "github" });
      return rows;
    },

    offerOf: placeId => kept.get(placeId)?.backendFacts?.offer ?? (providerIds().includes(placeId) ? placeId : undefined),

    backendOf(placeId) {
      const made = backends.get(placeId);
      if (made !== undefined) return made;
      const facts = kept.get(placeId)?.backendFacts;
      if (facts !== undefined) return backendFrom(placeId, facts);
      // No record and no facts: the word names a provider row rather than a computer, and its backend is the one
      // the host built for that provider.
      return kept.has(placeId) ? undefined : providerBackend(placeId);
    },

    joined: placeId => kept.has(placeId),

    folderComputer(placeId) {
      const record = kept.get(placeId);
      const home = record?.report.login["HOME"];
      if (record === undefined || home === undefined) return undefined;
      const path = record.report.login["PATH"];
      // One machine per computer while its home and PATH stand, so who its lines run as is read once there.
      const key = `${home}\0${path ?? ""}`;
      const held = folderMachines.get(placeId);
      const machine = held?.key === key ? held.machine : new PlaceFolderMachine(linkTo(placeId), { id: placeId, home, ...(path !== undefined && path !== "" ? { path } : {}) });
      if (held?.machine !== machine) folderMachines.set(placeId, { key, machine });
      return { machine, home, shape: record.report.shape, tools: record.report.wspDoor === true };
    },

    async forkingBackend(placeId) {
      const record = (await recordOf(placeId)) ?? kept.get(placeId);
      // A place that is no joined computer is a provider row: it forks by its own module and there is no link to
      // ask what it forks with.
      if (record === undefined) {
        const at = providerBackend(placeId);
        if (at !== undefined) return at;
      }
      const name = record?.name ?? placeId;
      if (record === undefined) {
        backends.delete(placeId);
        throw new PlaceForksNowhereError(placeForksNowhereLine(name));
      }
      // A computer whose setup is still going on is not forked into while it runs: the workspace would come up
      // without the agent the job is putting there. The running workspaces on it are untouched, since they read
      // backendOf and not this.
      const busy = foldersOf.getStore() === placeId ? undefined : settingNow(record);
      if (busy !== undefined) throw new PlaceProvisioningError(busy);
      const made = ctx.door.backendOf(placeId);
      if (made !== undefined) return made;
      // The first fork on this computer is where the host learns what it forks with; every road after it reads the
      // answer off the record, so this frame is sent once per computer and not once per fork.
      const inflight = asking.get(placeId);
      if (inflight !== undefined) return inflight;
      const read = (async () => {
        const answer = await bounded(linkTo(placeId).request("machine.backend"), BACKEND_FACTS_MS, `machine.backend on ${name}`);
        const facts = BackendFacts.parse(answer);
        // Onto the record as it stands rather than as it was when the frame went out, and only while the daemon
        // that answered is still the one running there: a computer that dialled back on another version while
        // this was out has a read of its own behind that attach, and this answer is not its facts any more.
        const wrote = await change(placeId, now => (now.report.daemonVersion === record.report.daemonVersion ? { ...now, backendFacts: facts } : undefined));
        return wrote === undefined ? LinkBackend.of(linkTo(placeId), facts) : backendFrom(placeId, facts);
      })().finally(() => asking.delete(placeId));
      asking.set(placeId, read);
      return read;
    },

    async forward(placeId, placePort, o = {}) {
      const key = o.pane !== undefined ? `${placeId}:open:${placePort}` : `${placeId}:${placePort}`;
      const conns = new Map<string, Socket>();
      /** One connection to this computer's port, carried as a tunnel to that computer's. */
      const tunnelled = (conn: Socket, used?: () => void): void => {
        const into = forwards.get(key)?.conns ?? conns;
        const tunnelId = `p${++tunnelSeq}`;
        const reach = live.get(placeId)?.reach;
        conn.on("error", () => {});
        if (reach === undefined) {
          // The listener stays bound while the place is away: the route this host handed out keeps its port, and a
          // connection made meanwhile is refused rather than held.
          conn.destroy();
          return;
        }
        used?.();
        into.set(tunnelId, conn);
        conn.pause();
        conn.on("close", () => {
          into.delete(tunnelId);
          used?.();
          void reach.request("tunnel.close", { tunnelId }).catch(() => undefined);
        });
        reach.request("tunnel.open", { tunnelId, port: placePort }).then(
          () => {
            conn.on("data", (d: Buffer) => void reach.request("tunnel.write", { tunnelId, data: d.toString("base64") }).catch(() => conn.destroy()));
            conn.resume();
          },
          () => {
            into.delete(tunnelId);
            conn.destroy();
          },
        );
      };
      if (o.pane !== undefined) return { localPort: o.standing === true ? panes.standing(key, placePort) : await panes.reach(key, placePort, o.pane, tunnelled) };
      const already = forwards.get(key);
      if (already !== undefined) return { localPort: already.localPort };
      const server = createServer(conn => tunnelled(conn));
      const localPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
          server.unref();
          const addr = server.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
        });
      });
      forwards.set(key, { server, localPort, conns });
      return { localPort };
    },

    paneForwards: panes,

    async placeFor(word) {
      const all = await records();
      const found = all.filter(r => namesPlace(r, word));
      // Two computers by one word is two a person joined under one name: a relink cannot take another's, so this
      // is theirs to tell apart, and every create and image build that names the word reads the ids rather than
      // landing on whichever record joined first.
      if (found.length > 1) throw new Error(twoPlacesRefusal(word, found.map(r => r.id)));
      if (found[0] !== undefined) return { placeId: found[0].id };
      const here = wiring.here().name;
      const providers = providerIds();
      // The wired provider is where a record with no place word already stands, so naming it is that same road and
      // the record stays as every record before joined computers existed.
      if (word === HERE_PLACE_ID || word === here || word === wiredProvider()) return {};
      if (providers.includes(word)) return { placeId: word };
      throw new Error(noSuchPlaceRefusal(word, [here, ...all.map(r => r.name), ...providers]));
    },

    async defaultPlace() {
      const marked = await defaultId();
      if (marked === undefined) return {};
      const found = (await records()).find(r => r.id === marked);
      if (found !== undefined) return { placeId: found.id };
      // A provider the last fork landed on that is not the one this host is wired to is still that place.
      return marked !== wiredProvider() && providerIds().includes(marked) ? { placeId: marked } : {};
    },

    async markUsed(placeId) {
      await markDefault(placeId ?? wiredProvider() ?? HERE_PLACE_ID);
    },

    async markDefaultIfNone(placeId) {
      await inTurn(async () => {
        if ((await markHeld()) === undefined) await store.put(DEFAULT_COLLECTION, DEFAULT_ID, { placeId });
      });
    },
  };
}
