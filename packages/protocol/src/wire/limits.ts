// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** The one rule for a URL a guest may hand to the laptop: http or https in any
 * case, no whitespace or control characters, at most HTTP_URL_MAX bytes, and
 * it parses (so a hostname can always be read from it without throwing). The
 * machine is the untrusted side, so the host and the app apply it too. The
 * daemon carries a copy (it must not bundle this package); a test pins the two
 * equal. */
export const HTTP_URL_RE = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/i;
export const HTTP_URL_MAX = 8192;
/** The most bytes one exec request body may carry, the backend's wrapper included: the provider answers 413 Payload
 * Too Large above 16 KiB (a 17,176 byte launch body was refused on 2026-09-06). Anything larger goes to the guest in
 * more than one exec or through an upload. */
export const EXEC_BODY_MAX = 16 * 1024;
/** The thread token and the turn token a guest session opens with; the daemon relays both and reads neither. */
export const GUEST_TOKEN_MAX = 512;
/** Words in one guest command line, and the length of the folder it runs in. */
export const GUEST_ARGV_MAX = 256;
export const GUEST_CWD_MAX = 4096;
/** The most stores one usage.logs names: the catalog's agents, so a handful. */
export const USAGE_STORES_MAX = 32;
/** How much of a detached command's output one poll exec reads; a full read is followed by another at once. */
export const EXEC_CHUNK_BYTES = 262_144;
/** How long a turn may do nothing at all before the runtime cuts it: no byte on its stream, no message from the
 * person, and no work in the process tree it started. It is the one rule that ends a turn the harness left hanging:
 * a fixed wall clock cut a build that was still working at 15 minutes on 2026-09-06. */
export const TURN_IDLE_MS = 10 * 60_000;
/** How hard the process tree a turn started has to be working for the turn to count as alive while it prints
 * nothing: ticks per second, where a tick is 10 ms of CPU or a megabyte of I/O anything the turn started moved. Five
 * percent of one core clears it, which a vitest batch or a packager does many times over; a harness process waking
 * on its own timers stays under it, so a turn nothing is working on is still cut at TURN_IDLE_MS. */
export const TURN_WORK_TICKS_PER_S = 5;
/** How long a thread's agent process is kept up after its turn on the computer the host runs on, for the next send
 * to skip the agent's boot. Half of the gaps from a turn's end to the thread's next send were under 30 minutes across
 * 299 turns on 147 threads (2026-09-27 to 10-04). */
export const AGENT_KEEP_MS = 30 * 60_000;
/** The most agent processes kept up between turns on that computer at once, the one idle longest ended first: an
 * idle one holds 200 to 400 MB with its MCP servers. */
export const AGENTS_KEPT = 6;
/** How long a harness gets to exit on its own after the result its turn ended on, before the runtime ends it and its
 * tree. Long enough for the harness to flush its own session store and go, short enough that a machine running turns
 * all day never carries more than the one it is on: seven finished turns' processes were found alive on one guest,
 * the oldest fourteen hours past its reply, and the box read load 25 while idle (2026-09-08). */
export const RUN_EXIT_MS = 10_000;
/** The longest a side question may run before its process is ended: a copy of a session with no tools answers in one
 * reply, so a harness still silent this long is stuck, and a stuck one holds the machine's memory for nobody. */
export const ASIDE_WALL_MS = 3 * 60_000;
/** How long a turn's process gets to go on the graceful signal before its group is killed, on either road: what the
 * guest's reap waits between its TERM and its KILL, and what a host gives the turns on this computer as it stops. */
export const RUN_STOP_MS = 2_000;
/** How long an interrupted turn's harness gets on the graceful signal before it and its tree are killed. */
export const INTERRUPT_GRACE_MS = 5_000;
/** How long a stop waits for the computer a turn runs on to answer a ping before it reads that computer as away: the
 * link's own heartbeat takes up to two beats, 20 s, to say so. */
export const STOP_REACH_MS = 3_000;
/** How long a road to a machine keeps being dialled while nothing answers before it is called down. The one rule
 * every link this project holds reads, which is why it lives here: the host's dial of a machine's daemon and its
 * re-dial after a drop, the post that launches or re-opens a turn's run, and the browser's link to a workspace.
 * Measured 2026-09-12: one resolver dropped the name of a machine's edge for about three minutes at a time while
 * the machines behind it went on running and their processes went on working, so a name that will not resolve is
 * worth a minute of asking. */
export const LINK_RETRY_WINDOW_MS = 60_000;

/** The wait before dial `attempt`, half a second doubling to ten, with up to a quarter second of jitter so the
 * turns of one machine do not all come back at the same instant after a blip. */
export function linkBackoffMs(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 250);
}

/** The close code a host sends the clients on its own socket as it stops: the socket did not break under them, the
 * host let it go, so a command waiting on a turn says the host is restarting rather than that the turn failed. */
export const HOST_STOPPING_CLOSE = 4001;
export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > HTTP_URL_MAX || !HTTP_URL_RE.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Every folder a turn's paths are built from is held to this: absolute, made of what a path is made of, and
 * never walking up out of itself. A machine can answer with anything, and what it answers lands in a mount and
 * in the commands a turn runs there, so a home carrying a semicolon, a quote, a backtick, a glob or a `..` is
 * refused at the one door rather than quoted or resolved at each of twenty places (the paths are quoted too;
 * this is what keeps a machine from deciding what those paths mean). A space is a path on macOS and stays
 * allowed, and a name that begins with a dot is a name. The one rule, read by the wire schemas here and by the
 * ssh read. */
export function isPlainPath(path: string): boolean {
  if (!path.startsWith("/") || !/^[A-Za-z0-9 ._+@:,/-]+$/.test(path) || path.includes("//")) return false;
  return !path.split("/").some(part => part === "." || part === "..");
}

/** A name under a folder the reader already holds, never a path of its own: the far side joins one of these onto
 * a folder here, so a leading slash, an empty part and a part that walks up out of it are refused at the wire
 * rather than resolved at the other end. The one rule, read by the wire schema here and by the daemon's own. */
export function isUnderPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").some(part => part === "" || part === "." || part === "..");
}

/** The host of a URL that passed isHttpUrl (with its port, without userinfo), or undefined when it does not parse: never throws. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** A callback port the laptop can bind without root; the host refuses anything else before it listens. */
export const RelayPort = z.number().int().min(1024).max(65535);
/** Ports forwarded to this computer's loopback for one workspace at once, by the relay for the links it prints and by
 * a Browser pane for a folder on a computer the person joined: the workspace names the ports, so its say over this
 * computer's loopback is bounded. */
export const FORWARD_MAX_PER_TARGET = 16;

/** Hosts a sign-in's redirect comes back to on the machine itself; anything else is a page the person finishes. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A sign-in URL's redirect_uri as a URL, or nothing when it carries none and when either fails to parse. */
function redirectOf(url: string): URL | undefined {
  try {
    const redirect = new URL(url).searchParams.get("redirect_uri");
    return redirect === null ? undefined : new URL(redirect);
  } catch {
    return undefined;
  }
}

/** Whether a sign-in's page comes back to the machine that asked for it: its redirect_uri names a loopback host,
 * port or no port (aws registers http://127.0.0.1/oauth/callback bare and binds its port at the time). This is what
 * tells the two roads apart, since a page that returns to the machine hands the person nothing to carry back. */
export function redirectsToMachine(url: string): boolean {
  const target = redirectOf(url);
  return target !== undefined && LOOPBACK_HOSTS.has(target.hostname);
}

/** Which port on the machine that redirect names, for the forward to bind here: the daemon reads it to name the port
 * on a browser.open. Absent when the page does not come back to the machine at all, when the redirect names no
 * explicit port, or when the port is one this computer could not bind. */
export function callbackPortOf(url: string): number | undefined {
  const target = redirectOf(url);
  if (target === undefined || !LOOPBACK_HOSTS.has(target.hostname) || target.port === "") return undefined;
  const port = Number(target.port);
  return RelayPort.safeParse(port).success ? port : undefined;
}

/** A guest port the host forwards to this computer's loopback (localhost:<port>
 * here reaches the workspace's listener). The host holds them; the app lists
 * them and stops them. name is what the app shows: the workspace's, or the
 * builder's, since a builder's forwards carry the builder id. kind says why the
 * port is open: url, a link the workspace printed, which the app offers to
 * open; callback, a sign-in flow's redirect, which the app names and never
 * dials (a bare request would end the flow). */
export const PortForward = z.object({ workspaceId: z.string(), port: RelayPort, startedAt: z.string(), name: z.string(), kind: z.enum(["url", "callback", "editor"]) });
export type PortForward = z.infer<typeof PortForward>;
