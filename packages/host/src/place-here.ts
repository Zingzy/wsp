// SPDX-License-Identifier: AGPL-3.0-only
// What a person sitting at a computer joined as a place can read about it
// without a host anywhere, which is the case they are in: the place file says
// which wsp the computer belongs to, and the daemon beside it answers on its
// own loopback port with the token in the same folder. Every frame asked for
// here is one the daemon answers by reading, so this is safe to run on a
// computer that is doing work, and safe to watch.
//
// One link, held. The daemon's samplers run only while a subscriber is there,
// so a reading that dialled again per frame would stop them, pay the whole of
// the first sample's interval again and draw every three seconds where every
// word about the flag says one. The link is held for the watch's life and the
// rows are drawn as the daemon pushes.
//
// The workspaces a place's daemon holds are not among the readings: the
// machine ops are answered on the link the daemon dials its host on and
// refused on every socket that dials in, so nothing a computer can ask of its
// own daemon says what it is running. What is here is what the computer
// itself is doing.

import { readFileSync } from "node:fs";
import { DAEMON_SAMPLER_INTERVAL_MS, LOOPBACK, ProcSnapshot, SysSample, byProcColumn, fmtBytes, fmtBytesOfTotal, fmtDuration, fmtElapsed, fmtPercent, fmtUptime, placeDaemonPaths, type DaemonEvent, type PlaceFile, type ProcEntry } from "@wsp/protocol";
import { connectDaemon, type DaemonReach } from "@wsp/runtime";
import { table } from "./verbs.js";
import { placeStanding } from "./places.js";

/** How long the daemon gets to push its first readings before the rows say it is not answering. Two of its own
 * sampler intervals: the first sample lands one interval after the reply, and a box under load slips a tick, so one
 * interval would be a race with the daemon on every reading. */
const ANSWER_MS = DAEMON_SAMPLER_INTERVAL_MS * 2;

/** How many processes a reading carries. The busiest first, so the rows say what the computer is spending itself
 * on; the whole count stands above them. */
const PROCESS_ROWS = 10;

/** What this computer says about itself, read off its own daemon. `refusal` is what the daemon would not say,
 * absent where it answered; `sys` and `procs` are absent with it. */
export interface HereReading {
  place: PlaceFile;
  /** The port the daemon wrote down, absent where it has written none, which is a daemon that never came up. */
  port?: number;
  refusal?: string;
  sys?: SysSample;
  procs?: ProcSnapshot;
  /** When the link this reading came over went quiet, absent while it is up. A daemon that is gone leaves its last
   * samples behind, and a row drawn off them alone would say the computer is answering for as long as somebody
   * watched it; every figure here is what was true at this moment and not a moment since. */
  droppedAt?: number;
  /** Where the agent on this computer writes what it has to say, which is the one thing to read when it said
   * nothing here. */
  logPath: string;
}

/** The link to this computer's daemon while somebody is reading it: the latest of each sample it has pushed, and a
 * wait that ends when the next one lands. Held for as long as the rows are being drawn and closed with them. */
export interface HereWatch {
  /** The reading as it stands, off the last sample of each kind the daemon pushed. */
  reading(): HereReading;
  /** Settles when the daemon pushes its next sample or the link goes quiet; never, where there is no link. */
  next(): Promise<void>;
  /** Whether there is a link at all. False where there was nothing to dial or the dial was refused, which is what a
   * watch opens again on: the one thing a person watches for after a join is the agent coming up. */
  linked: boolean;
  close(): void;
}

export interface HereDeps {
  /** A link to the daemon on this computer's own loopback. `onLive` carries every turn of the link: true when a
   * connect lands, which is where the watches are asked for again, and false when it drops and starts redialling,
   * which is what stops the rows saying the computer is answering. The real one dials; a test hands over its own. */
  dial(port: number, token: string, onEvent: (e: DaemonEvent) => void, onLive: (live: boolean) => void): DaemonReach;
  answerMs?: number;
}

export const systemHere = (): HereDeps => ({
  dial: (port, token, onEvent, onLive) =>
    connectDaemon({
      previewUrl: `http://${LOOPBACK}:${port}`,
      token,
      onEvent,
      // Every status but live is a link that is not carrying samples: connecting is the reach redialling after a
      // drop, and the two terminal ones are it giving up.
      onStatus: status => onLive(status === "live"),
    }),
});

/** A watch over a computer with no link to it: the reading it already is, and a wait that never ends, so the tick
 * alone draws it and the caller is the one that opens again. */
const settled = (reading: HereReading): HereWatch => ({ reading: () => reading, next: () => new Promise<void>(() => {}), linked: false, close: () => {} });

/** The work, or nothing once the wait is out. Nothing here waits on a daemon longer than it takes to say it is not
 * answering: a port file left behind by a daemon that died points at a port nothing listens on, and the reach
 * redials a refused connect for as long as it is held, so a wait on it alone never ends. */
function within<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  return Promise.race([work, new Promise<undefined>(resolve => void setTimeout(() => resolve(undefined), ms).unref())]);
}

/** What the row says about a daemon that never answered in the time it was given. */
const noAnswerIn = (ms: number): string => `nothing answered in ${fmtDuration(ms)}`;

/** One link to this computer's daemon, open and subscribed, or nothing when this computer belongs to no wsp, which
 * is every computer a host runs on. The caller closes it: the daemon's samplers stop with the last subscriber, so a
 * link left open would keep them running for as long as the terminal was there. */
export async function openHere(home: string, deps: HereDeps = systemHere(), now: () => number = Date.now): Promise<HereWatch | undefined> {
  const place = placeStanding(home);
  if (place === undefined) return undefined;
  const at = placeDaemonPaths(home);
  const logPath = at.placeLog;
  let port: number;
  let token: string;
  try {
    port = Number(readFileSync(at.portFile, "utf8").trim());
    token = readFileSync(at.tokenPath, "utf8").trim();
  } catch {
    return settled({ place, logPath });
  }
  if (!Number.isInteger(port) || port <= 0) return settled({ place, logPath });

  const answerMs = deps.answerMs ?? ANSWER_MS;
  let sys: SysSample | undefined;
  let procs: ProcSnapshot | undefined;
  let droppedAt: number | undefined;
  /** Whoever is waiting on the next turn of the link; one waiter, since one block draws these rows. */
  let waiting: (() => void) | undefined;
  const pushed = (): void => {
    const wake = waiting;
    waiting = undefined;
    wake?.();
  };
  // Set the moment the dial returns. A connect only ever lands a tick later, since it is a socket opening, so the
  // first of them is answered here as every one after a drop is.
  let subscribe: (() => void) | undefined;
  const link = deps.dial(
    port,
    token,
    event => {
      if (event.type === "sys.sample") sys = SysSample.parse(event);
      else if (event.type === "proc.snapshot") procs = ProcSnapshot.parse(event);
      else return;
      droppedAt = undefined;
      pushed();
    },
    live => {
      // A connect, the first and each one after a drop: a reconnect that did not ask again would leave the link
      // open and quiet, which reads on screen as a computer that stopped doing anything.
      if (live) {
        droppedAt = undefined;
        subscribe?.();
        return;
      }
      // The link went quiet. The rows say so at once rather than on the next tick, since what they would say until
      // then is that a computer nothing is answering for is answering.
      droppedAt ??= now();
      pushed();
    },
  );
  subscribe = () => void Promise.all([link.request("sys.watch"), link.request("proc.watch")]).catch(() => undefined);
  // A refused dial rejects ready; a port nothing listens on is redialled by the reach for as long as it is held, so
  // the wait is bounded and the row says what it found rather than the line hanging on it.
  const opened = await within(answerMs, link.ready.then(() => true as const, (e: unknown) => (e instanceof Error ? e.message : String(e))));
  if (opened !== true) {
    link.close();
    return settled({ place, port, logPath, refusal: opened ?? noAnswerIn(answerMs) });
  }
  droppedAt = undefined;
  // A sample that landed while the connect was still settling is already here: the wait is armed only when nothing
  // has arrived, since arming it after the fact would sit out the whole wait for a reading that came and went.
  if (sys === undefined && procs === undefined) await within(answerMs, new Promise<void>(resolve => (waiting = resolve)));
  waiting = undefined;
  return {
    reading: () => ({ place, port, logPath, ...(sys !== undefined ? { sys } : {}), ...(procs !== undefined ? { procs } : {}), ...(droppedAt !== undefined ? { droppedAt } : {}) }),
    next: () => new Promise<void>(resolve => (waiting = resolve)),
    linked: true,
    close: () => link.close(),
  };
}

/** One reading and the link closed behind it: what `wsp status` prints on a joined computer when nobody is
 * watching. A watch opens the link itself and holds it. */
export async function readHere(home: string, deps: HereDeps = systemHere()): Promise<HereReading | undefined> {
  const held = await openHere(home, deps);
  if (held === undefined) return undefined;
  try {
    return held.reading();
  } finally {
    held.close();
  }
}

/** The width every row's label is padded to, which the process table under them is indented by. */
const LABEL = 12;

/** The row every other row's value lines up against, as wsp status prints its own. */
const row = (label: string, value: string): string => `${label.padEnd(LABEL)}${value}`;

/** The busiest processes first, then the heaviest: what a computer is spending itself on, which is what a person
 * runs this to see. Read off one snapshot, so the order is the order of that one reading. */
const busiest = (procs: ProcSnapshot): ProcEntry[] => [...procs.procs].sort(byProcColumn("cpu")).slice(0, PROCESS_ROWS);

/** What wsp status prints on a computer joined to somebody's wsp: which wsp it belongs to, whether the agent here
 * is answering, what the computer is doing right now and what is running on it. Every row is label and value, as
 * the rows for a host serving here are. */
export function hereLines(reading: HereReading, now = Date.now()): string[] {
  const { place, sys, procs } = reading;
  // Every figure below is what the last sample carried, so on a link that has gone quiet they are read at the
  // moment it went quiet: an uptime counting on past that would be this line inventing a reading nothing sent.
  const at = reading.droppedAt ?? now;
  const rows = [row("place", `${place.name}, joined to ${place.hostName}`), row("wsp", wspRow(reading, now))];
  if (sys !== undefined) {
    rows.push(row("cpu", `${fmtPercent(sys.cpu / 100)} busy, load ${sys.load1.toFixed(2)}`));
    rows.push(row("memory", fmtBytesOfTotal(sys.mem.used, sys.mem.total)));
    rows.push(row("disk", fmtBytesOfTotal(sys.disk.used, sys.disk.total)));
  }
  if (procs !== undefined) {
    rows.push(row("processes", `${procs.total} on this computer, busiest first:`));
    rows.push(...table([["PID", "USER", "CPU", "MEMORY", "UP", "COMMAND"], ...busiest(procs).map(p => processLine(p, at))]).map(line => `${" ".repeat(LABEL)}${line}`));
  }
  return rows;
}

/** What the agent on this computer is doing, in one value: answering on its port, or why nothing was read off it,
 * with the one file to read next. Two halves as every refusal here has them: what is so, then where to look. */
function wspRow(reading: HereReading, now: number): string {
  if (hereAnswering(reading)) return `answering on port ${reading.port}`;
  const said =
    reading.droppedAt !== undefined
      ? `stopped answering on port ${reading.port} ${fmtElapsed(now - reading.droppedAt)} ago`
      : reading.port === undefined
        ? "nothing has come up on this computer since it joined"
        : `not answering on port ${reading.port}: ${reading.refusal ?? "it said nothing"}`;
  return `${said}; its log is ${reading.logPath}`;
}

const processLine = (p: ProcEntry, now: number): string[] => [String(p.pid), p.user, `${p.cpu.toFixed(1)}%`, fmtBytes(p.rss), fmtUptime(now - p.startedAt), p.cmdline === "" ? p.comm : p.cmdline];

/** Whether this computer's own wsp is answering, which is what the line's exit code is: it sent something, and the
 * link it sent it over has not gone quiet since. */
export const hereAnswering = (reading: HereReading): boolean => reading.droppedAt === undefined && (reading.sys !== undefined || reading.procs !== undefined);
