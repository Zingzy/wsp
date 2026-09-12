// SPDX-License-Identifier: AGPL-3.0-only
// What this computer is to another wsp, and the four things the window does
// about it: the join behind the first launch's join screen, what the join
// left standing, leaving, and the hold that keeps this computer out of idle
// sleep while it is joined. The join is the one wsp join a terminal runs,
// handed the line this computer's service manager starts the agent with;
// nothing about a join is decided here. Which field a refusal belongs under is
// the host's own reading, since that is where the reason is known.
//
// One join buys two things with one code: the place the other wsp keeps for
// this computer, and the device token this computer's own window holds. The
// second is written here as a host record, so the window opens on the wsp it
// joined the way it would have after wsp host connect, and leaving hands that token
// back before the place goes.
import {
  JoinRefused,
  aliasFrom,
  defaultHost,
  dialHost,
  disconnectCommand,
  joinPlace,
  joinedAlready,
  leavePlace,
  placeStanding,
  readHost,
  removeHost,
  runningWsp,
  setDefaultHost,
  writeHost,
  writePlaceAwake,
  type CliIO,
  type HostRecord,
} from "@wsp/host";
import { JoinAsk, joinAddressOf, placeFactsLine, sentPairCode, servedHostname, type HostOutcome, type PlaceStanding } from "@wsp/protocol";

export type { JoinAsk };

/** What a leave says on a computer that is in no wsp: there is nothing of anyone else's here to give back. */
export const NOT_JOINED_LINE = "This computer runs threads for no other wsp.";
/** What a leave says when the wsp over there could not be told: everything of that wsp's is off this computer, and
 * the person over there still sees it listed until they take it off themselves. */
export const LEFT_ALONE_LINE = "This computer left, but the wsp it joined could not be told; it still lists this computer until somebody removes it there.";
/** What a leave says when that wsp took the removal and then would not take its token back: this computer is out of
 * it either way, and the one thing still standing over there is a token only its person can take away. */
export const TOKEN_LEFT_LINE = "This computer left, but the token it held could not be handed back; the wsp over there holds it until somebody revokes it.";

/** Why a join did not happen, as one word the screen has a slot and a sentence for: a word that is no address, an
 * address nothing answered at, a code the host would not take, a computer already in a wsp, and anything this Mac
 * itself refused. The screen owns the words; this says which of them. */
export type JoinRefusal = "address" | "answer" | "code" | "already" | "shell";

/** The computer the person is sitting at, as the joined screen draws its card. */
export interface JoinedHere {
  name: string;
  /** Its cores, memory and the room left where its threads work, in the app's own words for them. */
  facts: string;
  docker: boolean;
}

export type JoinOutcome = { ok: true; here: JoinedHere } | { ok: false; why: JoinRefusal; said?: string };

export interface JoinRoadDeps {
  /** The person's home folder: the place file, its key and the agent's log all sit under it. */
  home: string;
  /** The wsp home: the hosts folder the window's own record goes in, read by the command line as well. */
  wspHome: string;
  /** This computer's own state file, which a dial to the wsp over there names and never reads. */
  statePath: string;
  /** The wsp command this app writes on every launch: the line the daemon reports as this computer's wsp, so an
   * agent's tools run the shim that follows the app wherever it moves. */
  shim: string;
  log(line: string): void;
  join?: typeof joinPlace;
  leave?: typeof leavePlace;
  dial?: typeof dialHost;
  disconnect?: typeof disconnectCommand;
}

export interface JoinRoad {
  join(ask: JoinAsk): Promise<JoinOutcome>;
  /** What this computer is to the wsp it joined, or nothing when it belongs to none. */
  standing(): PlaceStanding | undefined;
  /** The alias of the host record the join wrote, when both files stand: the window opens on it at every launch. */
  alias(): string | undefined;
  leave(): Promise<HostOutcome>;
  setAwake(on: boolean): Promise<PlaceStanding>;
}

const refuse = (q: string): Promise<string> => Promise.reject(new Error(`this window asks nothing: ${q}`));
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Only the join screen's own shape comes off the wire; anything else is refused before a road is walked. */
export function parseJoinAsk(raw: unknown): JoinAsk | undefined {
  const parsed = JoinAsk.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The alias the host record for a joined wsp wears, folded out of the address that answered first. The join writes
 * it and every later launch reads it, so the fold lives here once rather than at each end. */
function aliasOf(hostUrl: string): string | undefined {
  const name = servedHostname(hostUrl);
  return name === undefined ? undefined : aliasFrom(name);
}

export function joinRoad(deps: JoinRoadDeps): JoinRoad {
  const io: CliIO = { log: deps.log, error: deps.log, ask: refuse, askSecret: refuse };
  const joinAt = deps.join ?? joinPlace;
  const sweep = deps.leave ?? leavePlace;
  const dial = deps.dial ?? dialHost;
  const disconnect = deps.disconnect ?? disconnectCommand;
  const opts = { statePath: deps.statePath, home: deps.wspHome };

  /** The place file and the host record the join wrote, where both still stand. */
  const held = (): { place: NonNullable<ReturnType<typeof placeStanding>>; alias: string; record: HostRecord } | undefined => {
    const place = placeStanding(deps.home);
    const url = place?.hostUrls[0];
    const alias = url === undefined ? undefined : aliasOf(url);
    const record = alias === undefined ? undefined : readHost(deps.wspHome, alias);
    return place === undefined || alias === undefined || record === undefined ? undefined : { place, alias, record };
  };

  const standingOf = (place: NonNullable<ReturnType<typeof placeStanding>>): PlaceStanding => ({
    hostName: place.hostName,
    hostUrl: place.hostUrls[0] ?? "",
    alias: aliasOf(place.hostUrls[0] ?? "") ?? "",
    joinedAt: place.joinedAt,
    awake: place.awake === true,
  });

  return {
    async join(ask) {
      const url = joinAddressOf(ask.address);
      if (url === undefined) return { ok: false, why: "address" };
      if (joinedAlready(deps.home)) return { ok: false, why: "already" };
      // The join speaks to a terminal as it goes; those lines are for the log this window keeps, never for the
      // screen, which has two fixed lines to refuse in and writes its own to fit them.
      let joined: Awaited<ReturnType<typeof joinPlace>>;
      try {
        joined = await joinAt(io, {
          home: deps.home,
          addresses: [url],
          code: sentPairCode(ask.code.trim()),
          // The same code buys the token this window holds: the person meant one thing, and a second code typed on
          // the other screen would be the same intent asked for twice.
          client: true,
          wsp: { ...runningWsp(), shim: deps.shim },
        });
      } catch (e) {
        // The host's two words are about a field; the screen's five are about a sentence, and two of them are about
        // the address field: `address` for a word that is no address, which never reaches the host, and `answer` for
        // one it dialled and nothing answered at. The host's "address" is the second of those.
        return { ok: false, why: e instanceof JoinRefused ? (e.about === "code" ? "code" : "answer") : "shell", said: text(e) };
      }
      const hostUrl = joined.hostUrls[0];
      const alias = hostUrl === undefined ? undefined : aliasOf(hostUrl);
      // A join with no device token is a host from before one was minted: the place stands and the agent runs, and
      // the window stays on this computer rather than opening on a wsp it cannot present anything to.
      if (joined.device !== undefined && hostUrl !== undefined && alias !== undefined) {
        writeHost(deps.wspHome, alias, {
          url: hostUrl,
          deviceId: joined.device.deviceId,
          deviceToken: joined.device.deviceToken,
          pairedAt: new Date().toISOString(),
          label: joined.hostName,
          road: "direct",
        });
        if (defaultHost(deps.wspHome) === undefined) setDefaultHost(deps.wspHome, alias);
      }
      // The report is what this computer told the host about itself on the join frame, so the card the person reads
      // and the row the host keeps are one reading rather than two.
      const { report } = joined;
      return { ok: true, here: { name: report.name, facts: placeFactsLine(report.shape, report.diskFreeBytes), docker: report.docker } };
    },
    standing() {
      const place = placeStanding(deps.home);
      return place === undefined ? undefined : standingOf(place);
    },
    alias() {
      return held()?.alias;
    },
    async leave() {
      const place = placeStanding(deps.home);
      if (place === undefined) return { ok: false, at: "url", error: NOT_JOINED_LINE };
      const both = held();
      let note: string | undefined = both === undefined ? LEFT_ALONE_LINE : undefined;
      if (both !== undefined) {
        try {
          const client = await dial(deps.statePath, { aim: { kind: "alias", alias: both.alias, record: both.record }, home: deps.wspHome });
          try {
            const answer = await client.request<{ removed: boolean; swept: string[] }>("places.remove", { placeId: both.place.placeId });
            for (const line of answer.swept) deps.log(line);
          } finally {
            client.close();
          }
        } catch (e) {
          deps.log(text(e));
          note = LEFT_ALONE_LINE;
        }
      }
      // The hand back is its own dial, so it says its own sentence: a wsp that took the removal and then refused the
      // token back has let this computer go, and telling the person it was never told would be false.
      if (both !== undefined && note === undefined) {
        try {
          await disconnect(io, opts, [both.alias]);
        } catch (e) {
          deps.log(text(e));
          note = TOKEN_LEFT_LINE;
        }
      }
      // The sweep over there is the agent's own, and a computer whose agent was not running still holds its files;
      // this is what makes the place gone on this computer whichever way the leave went.
      if (placeStanding(deps.home) !== undefined) for (const line of await sweep(deps.home)) deps.log(line);
      // The record is this computer's road to a wsp it has left, so it goes even when nobody could be told. The
      // token it held is still good over there until that person revokes it, which is what the note above says.
      if (both !== undefined && note !== undefined) removeHost(deps.wspHome, both.alias);
      return note === undefined ? { ok: true } : { ok: false, at: "url", error: note };
    },
    async setAwake(on) {
      return standingOf(writePlaceAwake(deps.home, on));
    },
  };
}
