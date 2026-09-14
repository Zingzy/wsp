// SPDX-License-Identifier: AGPL-3.0-only
// The host's side of the guest road. A process inside a machine opened a
// session on that machine's own daemon; the daemon carried it up the link this
// host already holds, and this is what turns that into the wsp the process
// asked for. Nothing new is reachable from a fork: the session's own token is
// the thread's, and every op it leads to still enters this host through the
// socket door under that token, which is what refuses an op outside a thread's.
//
// One concern per interface: this door binds a session to the workspace its
// link serves and picks the kind; each kind is one module, and adding a kind is
// one module and one row in the table below.
import { agentsOffRefusal, type DaemonEvent, guestNoKindLine, guestNoSessionLine, HOST_TOKEN_ENV, HOST_URL_ENV, TURN_TOKEN_ENV, UNAUTHORIZED, type GuestKind } from "@wsp/protocol";
import type { Authed } from "@wsp/runtime";

/** The road back down to one machine's daemon, and which workspace that machine is. */
export interface GuestLink {
  workspaceId: string;
  request(op: string, params: Record<string, unknown>): Promise<unknown>;
}

/** What a kind's module is handed when a session opens: what the guest asked for, the environment its verbs run
 * under, and the two ways back to it. */
export interface GuestOpening {
  argv: readonly string[];
  cwd: string;
  /** The pair a verb reads its host and its token off, as a turn's own launch leaves them, plus the turn's token. */
  env: Record<string, string>;
  reply(message: unknown): void;
  close(error?: string): void;
}

/** One open session, as the door talks to it. */
export interface GuestSession {
  message(message: unknown): void;
  /** The guest's end went, or the workspace did: whatever this session holds open is dropped. A link that drops
   * and redials is neither, and the session stands across it. */
  close(): void;
}

/** A kind of guest session: the tool server, or one command line. */
export interface GuestKindModule {
  open(opening: GuestOpening): GuestSession;
}

export interface GuestDoor {
  event(link: GuestLink, event: DaemonEvent): void;
  /** The workspace is gone, or this host is closing: every session on it is dropped, since no socket is coming
   * back to name them, and with no workspace named, every session this door holds. A link that drops and redials
   * is not this: the rows stand and the sessions with them. */
  closeAll(workspaceId?: string): void;
}

export interface GuestDoorOptions {
  /** Who a token names, read through the same door every other road into this host reads it through. */
  authorize(token: string): Promise<Authed | undefined>;
  /** Where this host answers on its own loopback, which is what a session's verbs dial. */
  hostUrl(): string;
  /** One module per kind; a kind with no module here is closed with the same refusal an unknown one would be. */
  kinds: Readonly<Record<GuestKind, GuestKindModule>>;
}

/** The act a guest's token is minted for: the launch mints none where the workspace's agents may not spawn, so a
 * line from a turn that carries no token is that switch being off, said in the words the switch is turned on by. */
const NO_TOKEN_ACT = "thread_new" as const;

const keyOf = (workspaceId: string, session: string): string => `${workspaceId} ${session}`;

/** One session as the door holds it. The row is made the moment the open arrives and before the token is read,
 * because the frames of a session arrive in order and the read is a promise: a message that overtook the open
 * would otherwise reach nothing. It waits in `queued` until the kind's module has answered. The row outlives the
 * link it came in on: a machine names every session it still holds to the socket that watches next, so the row is
 * what a redial finds the session by rather than opening it a second time. */
interface Held {
  workspaceId: string;
  /** The road back down to this session's guest, as the last link that named the session left it: a link that
   * dropped and redialled is a new road to the same session, and the answers go down whichever one is there. */
  link: GuestLink;
  /** The frame the session opened with. A machine that was replaced counts its session ids from the start again,
   * so it is what tells a session named again from a different session under a name this host already holds.
   * Nothing on the wire names a daemon's life, so two sessions can still read alike: a guest with no turn token,
   * running the same line from the same folder under the same token on a rebuilt machine while this host still
   * holds the earlier session, is taken for that session and its own line never runs. A turn's guest carries the
   * turn's token and cannot be mistaken this way. */
  opening: string;
  session?: GuestSession;
  queued: unknown[];
  ended: boolean;
}

export function guestDoor(o: GuestDoorOptions): GuestDoor {
  const open = new Map<string, Held>();

  const down = (link: GuestLink, op: string, params: Record<string, unknown>): void => {
    // A link that went while a session was answering is the session ending, which the close below already did.
    void link.request(op, params).catch(() => undefined);
  };

  /** This end is finished with the session: the row goes and the machine is told, unless something ended it
   * already, which is what keeps a row that was refused or replaced from ending the session that took its name. */
  const endHere = (held: Held, session: string, error?: string): void => {
    if (held.ended) return;
    held.ended = true;
    open.delete(keyOf(held.workspaceId, session));
    down(held.link, "guest.close", { session, ...(error !== undefined ? { error } : {}) });
  };

  const opened = async (e: Extract<DaemonEvent, { type: "guest.opened" }>, held: Held): Promise<void> => {
    if (e.token === "") return endHere(held, e.session, agentsOffRefusal(held.workspaceId, NO_TOKEN_ACT));
    const who = await o.authorize(e.token);
    // The guest went while its token was being read, or a session took this one's name; nothing is opened either way.
    if (held.ended) return;
    // A thread's token and that thread's own workspace: a paired computer's token drives everything this host
    // holds and is not what a process inside a machine was handed.
    if (who?.kind !== "device" || who.device.scope?.workspaceId !== held.workspaceId) return endHere(held, e.session, UNAUTHORIZED);
    // A kind nobody built here is not a token nobody holds, so it says so in its own words.
    const module = o.kinds[e.kind];
    if (module === undefined) return endHere(held, e.session, guestNoKindLine(e.kind));
    const env: Record<string, string> = {
      [HOST_URL_ENV]: o.hostUrl(),
      [HOST_TOKEN_ENV]: e.token,
      ...(e.turnToken !== undefined ? { [TURN_TOKEN_ENV]: e.turnToken } : {}),
    };
    const session = module.open({
      argv: e.argv,
      cwd: e.cwd,
      env,
      reply: message => down(held.link, "guest.reply", { session: e.session, message }),
      close: error => endHere(held, e.session, error),
    });
    // A kind may answer and end inside its own open, which a refused command line does; so may the guest, while
    // this was opening. Either way what was just made is dropped rather than held for frames that cannot come.
    if (held.ended) {
      session.close();
      return;
    }
    held.session = session;
    for (const message of held.queued.splice(0)) session.message(message);
  };

  return {
    event(link, e) {
      switch (e.type) {
        case "guest.opened": {
          const key = keyOf(link.workspaceId, e.session);
          const opening = JSON.stringify(e);
          const holding = open.get(key);
          if (holding !== undefined) {
            // The session is already running here and the machine is naming it to the socket that watches now:
            // it answers down that link from here and runs nothing again, which is what keeps the side effect of
            // a command line whose reply was still in flight from landing a second time.
            if (holding.opening === opening) {
              holding.link = link;
              return;
            }
            // Not the frame the row opened with, so not that session: the machine behind this link was replaced
            // and counts its sessions from the start again. The row it named over goes.
            holding.ended = true;
            open.delete(key);
            holding.session?.close();
          }
          const held: Held = { workspaceId: link.workspaceId, link, opening, queued: [], ended: false };
          open.set(key, held);
          // The read of a token is a promise; a throw out of it closes the session rather than the link.
          void opened(e, held).catch(() => endHere(held, e.session, UNAUTHORIZED));
          return;
        }
        case "guest.message": {
          const held = open.get(keyOf(link.workspaceId, e.session));
          // A session this host no longer holds, because it restarted or because the workspace its link served is
          // gone: the machine's daemon still holds it, and the guest is waiting on an answer nothing here can give.
          // Ending it is what lets that process print one line and exit rather than wait for the life of the workspace.
          if (held === undefined) return down(link, "guest.close", { session: e.session, error: guestNoSessionLine });
          // The guest is on the end of this link, whatever link the session was opened on: a daemon old enough to
          // relay a session without naming it again after a redial is one whose frames are the only word on where
          // its guest is now.
          held.link = link;
          if (held.session === undefined) held.queued.push(e.message);
          else held.session.message(e.message);
          return;
        }
        case "guest.closed": {
          const key = keyOf(link.workspaceId, e.session);
          const held = open.get(key);
          open.delete(key);
          if (held === undefined) return;
          held.ended = true;
          held.session?.close();
          return;
        }
        default:
          return;
      }
    },
    closeAll(workspaceId) {
      for (const [key, held] of [...open]) {
        if (workspaceId !== undefined && held.workspaceId !== workspaceId) continue;
        open.delete(key);
        held.ended = true;
        held.session?.close();
      }
    },
  };
}
