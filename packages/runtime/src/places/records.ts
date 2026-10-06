// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import {
  HERE_PLACE_ID,
  PLACE_LINK_NONCE_BYTES,
  DAEMON_VERSION,
  NAP_AFTER_MS,
  placeCapOf,
  PlaceSettings,
  AGENTS_ON,
  agentsFrom,
  placeTakes,
  placeTurnLimit,
  settingFor,
  placeLinkTranscript,
  placeRefusalTranscript,
  sshRoadOf,
  type MachineSizeOffer,
  type PlaceAddJob,
  type PlaceAuthRefusal,
  type PlaceBack,
  type PlaceView,
  buildsImages,
} from "@wsp/protocol";
import type { MachineBackend } from "@wsp/engine";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret, signPlaceBytes } from "@wsp/keys";
import { PLACES, CAPS, DEFAULT_COLLECTION, DEFAULT_ID, type PlaceRecord, isPlaceRecord, type PlaceLogin, type PlaceChallenge } from "./types.js";
import { bounded, ADDS_KEPT, UPDATE_POLL_MS } from "./helpers.js";
import type { PlaceDoorContext } from "./context.js";

/** The place records as the store keeps them, the providers beside them, and the turns every write of one takes. */
export function placeRecords(ctx: PlaceDoorContext) {
  const { opts, store, wiring, recording, clockNow, dialWaitMs, kept } = ctx;

  const records = async (): Promise<PlaceRecord[]> => (await store.list(PLACES)).filter(isPlaceRecord).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  /** The provider this host forks on when nobody names a place: the place a record with no place word stands on.
   * The wiring is what says whether this host forks on a provider at all; a runtime served with no wiring of its
   * own has a one-row table standing for its backend, which is no place a person names. */
  const wiredProvider = (): string | undefined => wiring.provider?.()?.id;
  /** Every provider a fork can land at, in the table's own order, the wired one among them. A host wired to one
   * cloud that holds the key for another can fork at either, so both are rows a person names; a host wired to
   * nowhere still lists every other provider it holds a key for. */
  const providerIds = (): readonly string[] => {
    const wired = wiredProvider();
    const table = opts.providers?.();
    const listed = table?.list() ?? [];
    if (wired === undefined) return listed.filter(id => id !== table?.wired);
    return listed.includes(wired) ? listed : [wired];
  };
  /** The backend of a provider row, or nothing when the word names no provider this host holds a key for. */
  const providerBackend = (placeId: string): MachineBackend | undefined => opts.providers?.().backend(placeId);
  /** What one provider charges an hour for its default size, read off the backend the host built for it, so a row
   * added by saving a key carries its price with no second table. */
  const providerRate = (placeId: string): number | undefined => {
    const at = placeId === wiredProvider() ? undefined : providerBackend(placeId);
    if (at === undefined) return placeId === wiredProvider() ? wiring.provider?.()?.rateUsdPerHour : undefined;
    return at.pricing.rateUsdPerHour(at.pricing.defaultSize);
  };
  /** The sizes one provider offers, each at that provider's own rate, read off the backend the host built for it.
   * A picker that took one list for every row quoted one provider's prices under another's name. Empty where this
   * host holds no backend for the row, which is a row with no pick to offer rather than a row of free sizes. */
  const providerSizes = (placeId: string): readonly MachineSizeOffer[] => providerBackend(placeId)?.capabilities.sizes ?? [];
  /** What a row says about the image there: whether a copy can stand on it at all, and the build running or stopped
   * there. Nothing about the first for a place whose backend this host has not heard yet. */
  const imageFacts = (placeId: string, at: MachineBackend | undefined): Pick<PlaceView, "build" | "buildStopped" | "buildsImages"> => {
    const build = opts.copyBuild?.(placeId);
    return {
      ...(at !== undefined ? { buildsImages: buildsImages(at.capabilities) } : {}),
      ...(build !== undefined ? { build: build.line, ...(build.stopped ? { buildStopped: true } : {}) } : {}),
    };
  };
  const recordOf = async (placeId: string): Promise<PlaceRecord | undefined> => {
    const found = await store.get(PLACES, placeId);
    return isPlaceRecord(found) ? found : undefined;
  };
  const settingsOf = async (placeId: string): Promise<PlaceSettings> => {
    const parsed = PlaceSettings.safeParse(await store.get(CAPS, placeId));
    return parsed.success ? parsed.data : {};
  };
  /** What settingsAt answers: every place's settings as load read them, written again by every set and remove. */
  const settingsHeld = new Map<string, PlaceSettings>();
  /** Every row's id and kind without asking any computer anything: what the running count places a workspace by. */
  const rowIds = async (): Promise<Pick<PlaceView, "id" | "kind">[]> => [
    { id: HERE_PLACE_ID, kind: "computer" },
    ...(await records()).map(r => ({ id: r.id, kind: "computer" as const })),
    ...providerIds().map(id => ({ id, kind: "provider" as const })),
  ];
  /** A row with its cap, its kind's default and what the person set, and what that cap counts, all read now. */
  const withCap = async (row: PlaceView, ids: readonly Pick<PlaceView, "id" | "kind">[]): Promise<PlaceView> => {
    const settings = await settingsOf(row.id);
    const cap = placeCapOf(row, settings);
    const capDefault = placeCapOf(row);
    const napDefault = opts.napMs ?? NAP_AFTER_MS;
    return {
      ...row,
      ...(cap !== undefined ? { cap } : {}),
      ...(capDefault !== undefined ? { capDefault } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(placeTakes(row, "nap") ? { napMs: settingFor(undefined, settings.napMs, napDefault), napDefault } : {}),
      turnLimitMs: placeTurnLimit(row.kind, settings),
      turnLimitDefault: placeTurnLimit(row.kind, {}),
      spawn: agentsFrom(undefined, settings.spawn ?? {}),
      spawnDefault: AGENTS_ON,
      running: await recording.runningOn(row.id, ids),
    };
  };
  /** The version the place reports once it has dialled back, or what it still reads when the wait runs out. The
   * record is what a link writes its report onto, so this reads the one fact every other row reads. */
  const untilDaemonVersion = async (placeId: string, from: number, waitMs: number): Promise<number> => {
    const until = clockNow() + waitMs;
    for (;;) {
      const version = (await recordOf(placeId))?.report.daemonVersion ?? from;
      if (version >= DAEMON_VERSION || clockNow() >= until) return version;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, UPDATE_POLL_MS);
        timer.unref?.();
      });
    }
  };

  /** The installs waiting on a computer to dial in, keyed by the code each handed it: the join notes which place
   * the code became and the attach that follows wakes the install. The login the install logged in over is here
   * too, from the moment its ssh answered, since the record is written by whichever of the two lands second. */
  const awaiting = new Map<string, { placeId?: string; login?: PlaceLogin; back?: PlaceBack; woken?: (placeId: string) => void }>();

  /** The adds over ssh, oldest first, for the host's life: a finished one past the last ADDS_KEPT goes. */
  const adds = new Map<string, PlaceAddJob>();
  const putAdd = (addId: string, next: (job: PlaceAddJob) => PlaceAddJob): void => {
    const job = adds.get(addId);
    if (job === undefined) return;
    adds.set(addId, next(job));
    const finished = [...adds.values()].filter(j => j.state !== "running");
    for (const gone of finished.slice(0, Math.max(0, finished.length - ADDS_KEPT))) adds.delete(gone.addId);
  };

  /** The road the install came in over, written onto a record: the join frame the record is made from says nothing
   * about how the computer was reached, and every later dial, update and read of its log rides this login. */
  const withRoad = (record: PlaceRecord, install: { login?: PlaceLogin; back?: PlaceBack } | undefined): PlaceRecord =>
    install?.login === undefined
      ? record
      : {
          ...record,
          road: {
            ...record.road,
            ssh: install.login.ssh,
            ...(install.login.keyPath !== undefined ? { keyPath: install.login.keyPath } : {}),
            ...(install.login.hostKey !== undefined ? { hostKey: install.login.hostKey } : {}),
            ...(install.back !== undefined ? { back: install.back } : {}),
          },
        };

  /** The login this host holds for a computer, as every road that logs in to one takes it: the address in the
   * spelling a person would type and the key file the add named beside it, off the record's own road. Nothing
   * where the record carries none, which is a computer that joined by typing a code. */
  const loginOf = (record: PlaceRecord): PlaceLogin | undefined => {
    const ssh = sshRoadOf(record.road);
    return ssh === undefined ? undefined : { ssh, ...(record.road?.keyPath === undefined ? {} : { keyPath: record.road.keyPath }), ...(record.road?.hostKey === undefined ? {} : { hostKey: record.road.hostKey }) };
  };

  /** The password a remove or an update over a login rides, where that login's sudo asks for one and took the one
   * the person typed; nothing where the login reaches root without one. Throws the add's own refusal otherwise. */
  const rootOver = async (login: PlaceLogin, sudoPassword: string | undefined, act: { verb: "remove" | "update"; name: string }): Promise<string | undefined> =>
    wiring.sudoOver === undefined ? undefined : (await wiring.sudoOver(login, sudoPassword, act)) === "taken" ? sudoPassword : undefined;

  /** Whether the login this host holds for a computer answers at all, over the one probe that installs nothing and
   * leaves nothing running, bounded as every other dial of a computer is. Its point is what it saves: the leave
   * that follows waits out systemd's own stop, which is minutes, and a computer whose ssh answers nothing would
   * charge a person watching a button all of it. A runtime wired with no probe has nothing to say against trying,
   * so it answers yes. */
  const loginAnswers = async (login: PlaceLogin): Promise<boolean> => {
    if (wiring.dial === undefined) return true;
    try {
      await bounded(wiring.dial(login), dialWaitMs, `ssh ${login.ssh}`);
      return true;
    } catch {
      return false;
    }
  };

  /** The login an install in flight logged in over, by the place its code became; nothing for every computer no
   * install is putting the agent on right now, whose record already carries whatever road it has. */
  const roadOfInstall = (placeId: string): { login?: PlaceLogin; back?: PlaceBack } | undefined => {
    for (const waiting of awaiting.values()) if (waiting.placeId === placeId) return waiting;
    return undefined;
  };

  /** Keeps the forward a record dials back through held, and writes the port it moved to onto every record of that
   * login. Nothing for a record with no forward, or a host wired with no holder. */
  const holdBack = (record: PlaceRecord): void => {
    const login = loginOf(record);
    const back = record.road?.back;
    const home = record.report.login["HOME"];
    if (wiring.back === undefined || login === undefined || back === undefined || home === undefined) return;
    const moved = (to: PlaceBack): void => {
      void (async () => {
        for (const id of [...kept.keys()]) {
          await change(id, now => (loginOf(now)?.ssh === login.ssh && now.road !== undefined ? { ...now, road: { ...now.road, back: to } } : undefined));
        }
      })().catch(() => undefined);
    };
    // The holder makes it again for as long as it is held, so a first try that failed is not the last.
    void wiring.back.hold(login, back, { home }, moved).catch(() => undefined);
  };

  /** The one write of a place record: the store and the memory the sync roads read both move, so a backend answered
   * without a read is never answered off a record the store has moved past. An install still in flight has its
   * login written on every one of them, so the join's own record and the link's first write carry the road back
   * rather than a write after the wait having to add it. */
  const keep = async (record: PlaceRecord): Promise<PlaceRecord> => {
    const held = withRoad(record, roadOfInstall(record.id));
    kept.set(held.id, held);
    await store.put(PLACES, held.id, held);
    return held;
  };
  const defaultId = async (): Promise<string | undefined> => {
    const held = (await store.get(DEFAULT_COLLECTION, DEFAULT_ID)) as { placeId?: unknown } | undefined;
    return typeof held?.placeId === "string" ? held.placeId : undefined;
  };
  // Every write of the mark takes its turn here, so a check-then-write at a seal never lands over a mark set meanwhile.
  let marking: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(write: () => Promise<T>): Promise<T> => {
    const run = marking.then(write);
    marking = run.catch(() => {});
    return run;
  };
  const markDefault = (placeId: string): Promise<void> => inTurn(() => store.put(DEFAULT_COLLECTION, DEFAULT_ID, { placeId }));
  /** The mark while it names this computer or a place this host still holds; a mark on a row since gone is none. */
  const markHeld = async (): Promise<string | undefined> => {
    const marked = await defaultId();
    if (marked === undefined) return undefined;
    return marked === HERE_PLACE_ID || providerIds().includes(marked) || (await records()).some(r => r.id === marked) ? marked : undefined;
  };

  /** The host's half of the handshake, the one place it is built and the one place its private key is read: a
   * fresh nonce and a fresh key agreement, the signature over the transcript the other end challenged with, the
   * bytes that end's own signature must cover, and the seal every frame after this reply rides inside. The
   * ephemerals are inside both transcripts, so the key the two ends agree is one both signatures cover and a
   * carrier that swapped either has signed nothing. `subject` is the place id for a link and the client's word
   * for a native client, which holds no record here and signs nothing back. Nothing where the other end sent no
   * key of its own to agree with. */
  const challenge = (subject: string, theirNonce: string, theirEphemeral: string | undefined): PlaceChallenge | undefined => {
    if (theirEphemeral === undefined) return undefined;
    const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
    const mine = freshEphemeral();
    let secret: Buffer;
    try {
      secret = sharedSecret(mine.privateKey, theirEphemeral);
    } catch {
      return undefined;
    }
    return {
      nonce,
      hostPublicKey: wiring.hostKey.publicKey,
      ephemeral: mine.publicKey,
      signature: signPlaceBytes(wiring.hostKey.privateKeyPem, placeLinkTranscript("host", subject, theirNonce, nonce, { challenger: theirEphemeral, answerer: mine.publicKey })),
      expect: placeLinkTranscript("place", subject, nonce, theirNonce, { challenger: mine.publicKey, answerer: theirEphemeral }),
      seal: makeSeal(sealKeys(secret, subject), "host"),
    };
  };

  /** This host's word on a refusal it sends before it has proved anything else: its key, and its signature over
   * the place id, the nonce that dial challenged with and the sentence. */
  const signedRefusal = (placeId: string, placeNonce: string, sentence: string): PlaceAuthRefusal => ({
    hostPublicKey: wiring.hostKey.publicKey,
    signature: signPlaceBytes(wiring.hostKey.privateKeyPem, placeRefusalTranscript(placeId, placeNonce, sentence)),
  });

  const writeSeen = async (placeId: string, at: number): Promise<void> => {
    await change(placeId, now => ({ ...now, lastSeenAt: new Date(at).toISOString() }));
  };

  /** The read-then-write of a computer's record, one at a time per computer: every write that starts from the
   * record as it stands reads it and writes it in here, or it lands over a field another write set meanwhile. */
  const recordTurns = new Map<string, Promise<unknown>>();
  const inRecordTurn = <T>(placeId: string, write: () => Promise<T>): Promise<T> => {
    const run = (recordTurns.get(placeId) ?? Promise.resolve()).then(write);
    const settled = run.catch(() => undefined);
    recordTurns.set(placeId, settled);
    void settled.then(() => {
      if (recordTurns.get(placeId) === settled) recordTurns.delete(placeId);
    });
    return run;
  };

  /** One change of a computer's record as it stands, in its turn: what was written, or nothing where `move` left it
   * as it was or a remove took the record first, which takes it in the same turn. */
  const change = (placeId: string, move: (now: PlaceRecord) => PlaceRecord | undefined): Promise<PlaceRecord | undefined> =>
    inRecordTurn(placeId, async () => {
      const now = await recordOf(placeId);
      const next = now === undefined ? undefined : move(now);
      return next === undefined ? undefined : keep(next);
    });

  return {
    records, wiredProvider, providerIds, providerBackend, providerRate, providerSizes, imageFacts, recordOf,
    settingsOf, settingsHeld, rowIds, withCap, untilDaemonVersion, awaiting, adds, putAdd, loginOf, rootOver,
    loginAnswers, holdBack, keep, defaultId, inTurn, markDefault, markHeld, challenge, signedRefusal, writeSeen,
    inRecordTurn, change,
  };
}
export type PlaceRecordsArea = ReturnType<typeof placeRecords>;
