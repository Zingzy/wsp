// SPDX-License-Identifier: AGPL-3.0-only
// A login signed in once on a computer you own: the tool's own device-code
// flow run on that computer's terminal, with its store pointed at the
// directory its daemon keeps the shared logins in, outside every workspace
// there. Every workspace on that computer mounts the one file, so a refresh
// inside any of them is that computer's refresh, and nothing of the login is
// ever in an image. The pty is that computer's own, reached through the host
// over the link the computer is holding: nothing here dials it.
import { hasLogin, loginHomeIn, loginSignIn, sharedLoginOf, type SharedLogin } from "@wsp/catalog";
import { shellQuote } from "@wsp/protocol";
import { relayPty, runQuiet, type PtyLink, type RelayTerminal } from "./signin-relay.js";
import type { HostClient } from "./verbs.js";

/** The whole wait a sign-in on a computer you own gets: a person opens a page and types a code in it, which is
 * minutes rather than the two the build's own sign-ins are held to. */
export const BOX_SIGN_IN_MS = 10 * 60_000;
/** The tool's own status command afterwards, which reads a file and answers at once. */
const STATUS_MS = 20_000;

/** A pty on one computer the person owns, driven from this terminal: the frames ride the host's channel to the
 * daemon on that computer, and the events it pushes come back on the same channel. The close is the caller's. */
export interface PlaceLink {
  link: PtyLink;
  close(): Promise<void>;
}

/** Opens the channel and shapes it as the pty road takes it. The host refuses this to anything but its own
 * terminal and its own window, and answers with the computer's own sentence when it is not connected. */
export async function placeLink(client: HostClient, placeId: string): Promise<PlaceLink> {
  const { channel } = await client.request<{ channel: string }>("daemon.open", { placeId });
  const readers = new Set<(e: Record<string, unknown>) => void>();
  let gone: (() => void) | undefined;
  const closed = new Promise<void>(r => (gone = r));
  const off = client.onFrame(frame => {
    if (frame["channel"] !== channel) return;
    if (frame["type"] === "daemon.event") {
      const event = frame["event"];
      if (event !== null && typeof event === "object") for (const read of readers) read(event as Record<string, unknown>);
      return;
    }
    if (frame["type"] === "daemon.closed") gone?.();
  });
  void client.closed.then(() => gone?.());
  return {
    link: {
      op: async (op, extra) => (await client.request<{ reply: Record<string, unknown> }>("daemon.send", { channel, frame: { op, ...extra } })).reply,
      onEvent: fn => {
        readers.add(fn);
        return () => readers.delete(fn);
      },
      closed,
    },
    close: async () => {
      off();
      gone?.();
      await client.request("daemon.close", { channel }).catch(() => undefined);
    },
  };
}

/** What a computer's own sign-in row is, or nothing: an agent whose login lives on the computer that runs the
 * workspaces declares what it shares, and that declaration is the only thing that makes this road exist. */
export function sharedOn(agent: string): SharedLogin | undefined {
  const row = loginSignIn(agent);
  return row === undefined ? undefined : sharedLoginOf(row);
}

/** Which of the agents a computer reported sign in there once rather than in the image, in the order it named them. */
export function sharedAgentsOn(agents: readonly string[]): string[] {
  return agents.filter(id => sharedOn(id) !== undefined);
}

export interface BoxSignIn {
  link: PtyLink;
  /** The agent's catalog id; its row says what it shares, how it signs in with no browser there, and its status. */
  agent: string;
  /** Where that computer's daemon keeps the logins its workspaces share, off what its backend said. */
  logins: string;
  terminal: RelayTerminal;
  /** Opens a URL on this computer; the person presses o for it, as they do on a builder. */
  open(url: string): Promise<boolean>;
  timeoutMs?: number;
}

export interface BoxSignedIn {
  signedIn: boolean;
  /** Which of the tool's own login sources it says is in use, where its status says; nothing where it does not. */
  detail?: string;
  /** Why it is not signed in, in the tool's own words where it gave any. */
  said?: string;
}

/** Signs the tool in on that computer: its store's directory made first, the no-browser flow run on its own
 * terminal with the store named in the pty's environment rather than quoted into the line, then the tool's own
 * status read with that same store. Nothing is typed here but what the person types. */
export async function signInOnBox(o: BoxSignIn): Promise<BoxSignedIn> {
  const row = loginSignIn(o.agent);
  const shared = row === undefined ? undefined : sharedLoginOf(row);
  if (row === undefined || shared === undefined || !hasLogin(row)) throw new Error(`${o.agent} has no login that lives on the computer running the workspaces`);
  const home = loginHomeIn(o.logins, shared);
  const env = { [shared.homeEnv]: home };
  // The tool writes its login here, so the directory is this road's to make: the daemon owns the one above it.
  await o.link.op("exec", { cmd: `mkdir -p ${shellQuote(home)}` });
  // The device-code variant: nobody is at that computer's browser, so the page opens here and the code is typed
  // where the tool asked for it, which is the terminal this relay is showing.
  const outcome = await relayPty({
    link: o.link,
    command: row.fallback ?? row.login,
    terminal: o.terminal,
    open: o.open,
    env,
    timeoutMs: o.timeoutMs ?? BOX_SIGN_IN_MS,
  });
  if (row.status === undefined) return { signedIn: outcome.exitCode === 0 };
  const status = await runQuiet(o.link, row.status.typed ?? row.status.command, STATUS_MS, env);
  const signedIn = row.status.signedIn(status.output, status.exitCode);
  const detail = row.status.detail?.(status.output, new Map());
  return {
    signedIn,
    ...(signedIn && detail !== undefined ? { detail } : {}),
    ...(!signedIn ? { said: row.status.why?.(status.output) ?? lastLine(status.output) } : {}),
  };
}

/** The last thing the tool said, for the line that reports a sign-in that did not land. */
function lastLine(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
  return lines.at(-1);
}
