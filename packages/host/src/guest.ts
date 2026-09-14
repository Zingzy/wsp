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
  /** The guest's end went, or the link did: whatever this session holds open is dropped. */
  close(): void;
}

/** A kind of guest session: the tool server, or one command line. */
export interface GuestKindModule {
  open(opening: GuestOpening): GuestSession;
}

export interface GuestDoor {
  event(link: GuestLink, event: DaemonEvent): void;
  /** The link is gone for good: every session on it is dropped. */
  closeAll(workspaceId: string): void;
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
 * would otherwise reach nothing. It waits in `queued` until the kind's module has answered. */
interface Held {
  workspaceId: string;
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

  const opened = async (link: GuestLink, e: Extract<DaemonEvent, { type: "guest.opened" }>, held: Held): Promise<void> => {
    const key = keyOf(link.workspaceId, e.session);
    const refuse = (error: string): void => {
      open.delete(key);
      down(link, "guest.close", { session: e.session, error });
    };
    if (e.token === "") return refuse(agentsOffRefusal(link.workspaceId, NO_TOKEN_ACT));
    const who = await o.authorize(e.token);
    // A thread's token and that thread's own workspace: a paired computer's token drives everything this host
    // holds and is not what a process inside a machine was handed.
    if (who?.kind !== "device" || who.device.scope?.workspaceId !== link.workspaceId) return refuse(UNAUTHORIZED);
    // A kind nobody built here is not a token nobody holds, so it says so in its own words.
    const module = o.kinds[e.kind];
    if (module === undefined) return refuse(guestNoKindLine(e.kind));
    // The guest went while its token was being read; nothing is opened for a session nobody is on the end of.
    if (held.ended) return;
    const env: Record<string, string> = {
      [HOST_URL_ENV]: o.hostUrl(),
      [HOST_TOKEN_ENV]: e.token,
      ...(e.turnToken !== undefined ? { [TURN_TOKEN_ENV]: e.turnToken } : {}),
    };
    const session = module.open({
      argv: e.argv,
      cwd: e.cwd,
      env,
      reply: message => down(link, "guest.reply", { session: e.session, message }),
      close: error => {
        held.ended = true;
        open.delete(key);
        down(link, "guest.close", { session: e.session, ...(error !== undefined ? { error } : {}) });
      },
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
          if (open.has(key)) return;
          const held: Held = { workspaceId: link.workspaceId, queued: [], ended: false };
          open.set(key, held);
          // The read of a token is a promise; a throw out of it closes the session rather than the link.
          void opened(link, e, held).catch(() => {
            open.delete(key);
            down(link, "guest.close", { session: e.session, error: UNAUTHORIZED });
          });
          return;
        }
        case "guest.message": {
          const held = open.get(keyOf(link.workspaceId, e.session));
          // A session this host no longer holds, because it restarted or because the link it rode ended: the
          // machine's daemon still holds it, and the guest is waiting on an answer nothing here can give. Ending it
          // is what lets that process print one line and exit rather than wait for the life of the workspace.
          if (held === undefined) return down(link, "guest.close", { session: e.session, error: guestNoSessionLine });
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
        if (held.workspaceId !== workspaceId) continue;
        open.delete(key);
        held.ended = true;
        held.session?.close();
      }
    },
  };
}
