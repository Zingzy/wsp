// SPDX-License-Identifier: AGPL-3.0-only
// The forwards over ssh a host holds for computers that cannot reach it: one
// ssh child per login, from a port on that computer's own loopback to this
// host's door, made again whenever it ends for as long as it is held.

import { randomInt } from "node:crypto";
import { LOOPBACK, PLACE_FILE_MODE, authority, isLoopback, parsePlaceFile, placeDaemonPaths, placeFileText, shellQuote, type PlaceBack } from "@wsp/protocol";
import { SSH_DIAL_MS, SSH_LINE_CAP, carriedSshValues, holdBackForward, keyFingerprint, parseSshAddress, sshClient, type BackForward, type SshCarried, type SshReach, type SshSpawn, type SshTransport } from "@wsp/engine";
import type { PlaceBackHolder, PlaceLogin } from "@wsp/runtime";

/** How much of the box's place file is read: a real one is well under a kilobyte, and the box is the untrusted side. */
const HELD_PLACE_READ_BYTES = 65_536;

/** The place file on the box, read before anything of wsp's lands and before a forward's new port is written into
 * it: empty where it holds none. */
export const heldPlaceScript = (home: string): string => `head -c ${HELD_PLACE_READ_BYTES} ${shellQuote(placeDaemonPaths(home).placeFile)} 2>/dev/null || true`;

/** The address a box's link dials for a forward standing on its own loopback. */
export const backUrl = (boxPort: number): string => `http://${authority(LOOPBACK, boxPort)}`;

/** How long the child gets to stand the forward: the dial, the login and sshd's answer to the forward. */
const BACK_UP_MS = 20_000;

/** A forward that stood this long was a working one, so the next remake starts from the bottom of the waits. */
const BACK_SETTLED_MS = 60_000;

/** The wait before remake n, the shape the box's own link waits in: two seconds doubling to thirty. */
export const backWaitMs = (attempt: number): number => Math.min(30_000, 2_000 << Math.min(4, Math.max(0, attempt - 1)));

/** Where a port is picked when the one asked for is taken on the box: below Linux's own range for outbound
 * connections, so the pick does not meet a port the box hands out itself. */
const pickBoxPort = (): number => randomInt(10_000, 32_768);

/** What ssh says under ExitOnForwardFailure when sshd would not bind the port or would not take the forward at all
 * (AllowTcpForwarding); the two read the same. */
const FORWARD_REFUSED = "remote port forwarding failed for listen port";

/** Every listener on the port asked about, one line each, off ss where the box has it and /proc where it does not. */
export function backBindScript(port: number): string {
  return [
    "if command -v ss >/dev/null 2>&1; then",
    `  ss -ltnH ${shellQuote(`sport = :${port}`)} | while read -r _ _ _ at _; do echo "WSP_BIND $at"; done`,
    "else",
    '  for f in /proc/net/tcp /proc/net/tcp6; do [ -r "$f" ] && while read -r _ at _ st _; do [ "$st" = 0A ] && echo "WSP_BINDHEX $at"; done < "$f"; done',
    "fi",
    "true",
  ].join("\n");
}

/** A local address as /proc/net/tcp writes it: IPv4 as one little-endian word, IPv6 as four. */
function hexAddress(hex: string): string {
  const word = (w: string): string[] => (w.match(/../g) ?? []).reverse();
  if (hex.length === 8) return word(hex).map(b => parseInt(b, 16)).join(".");
  const bytes = (hex.match(/.{8}/g) ?? []).flatMap(word);
  if (bytes.slice(0, 10).every(b => b === "00") && bytes[10] === "FF" && bytes[11] === "FF") return bytes.slice(12).map(b => parseInt(b, 16)).join(".");
  if (bytes.slice(0, 15).every(b => b === "00") && bytes[15] === "01") return "::1";
  return (bytes.join("").match(/.{4}/g) ?? []).join(":").toLowerCase();
}

/** The addresses the box says something listens on at that port, off what backBindScript printed. */
export function backBinds(said: string, port: number): string[] {
  const found: string[] = [];
  for (const line of said.split("\n").slice(0, 256)) {
    const ss = /^WSP_BIND (\S+):(\d+)$/.exec(line.trim());
    if (ss !== null && Number(ss[2]) === port) found.push(ss[1]!.replace(/^\[|\]$/g, "").replace(/%\S*$/, ""));
    const proc = /^WSP_BINDHEX ([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(line.trim());
    if (proc !== null && parseInt(proc[2]!, 16) === port) found.push(hexAddress(proc[1]!.toUpperCase()));
  }
  return found;
}

/** Why a forward that stood was cut: sshd put it somewhere other than the box's loopback (GatewayPorts yes), where
 * anything that reaches the box would reach this host's door, or the box would not say where it went. */
export const backBindLine = (login: string, bound: string | undefined): string =>
  (bound === undefined
    ? `wsp could not see where ${login}'s sshd put the forward back to this computer, so it cut it; check that ss or /proc/net/tcp answers there`
    : `${login}'s sshd put the forward back to this computer on ${bound}, beyond its own loopback, so wsp cut it; set GatewayPorts to clientspecified or no in its sshd_config, or link this host to your relay`
  ).slice(0, SSH_LINE_CAP);

/** The line for a forward whose up line never came. */
const backSlowLine = (login: string): string => `${login} did not stand the forward back to this computer within ${BACK_UP_MS / 1000}s`;

/** A refusal that making the forward again would only repeat, said whole since it carries its own fix. */
export class BackCutError extends Error {}

export interface PlaceBackDeps {
  /** The fingerprint of this host's own key: a place file naming any other is another wsp's and is never written. */
  hostKey: string;
  carry?: (reach: SshReach) => Promise<SshCarried>;
  spawn?: SshSpawn;
  transport?: SshTransport;
  pickPort?: () => number;
  waitMs?: (attempt: number) => number;
  upMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface Held {
  login: PlaceLogin;
  back: PlaceBack;
  home: string;
  moved?: (back: PlaceBack) => void;
  child?: BackForward;
  released: boolean;
  first: Promise<PlaceBack>;
  wake?: () => void;
  said?: string;
}

/** The holder a host wires: the installer holds a forward before the deploy, the records keep it held. */
export function placeBackHolder(deps: PlaceBackDeps): PlaceBackHolder {
  const carry = deps.carry ?? (reach => carriedSshValues(reach));
  const transport = deps.transport ?? sshClient;
  const pickPort = deps.pickPort ?? pickBoxPort;
  const waitMs = deps.waitMs ?? backWaitMs;
  const upMs = deps.upMs ?? BACK_UP_MS;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const held = new Map<string, Held>();

  const reachOf = (login: PlaceLogin): SshReach => parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });

  /** One child at one port, up or refused within the bound. */
  const stand = async (h: Held, carried: SshCarried, boxPort: number): Promise<BackForward> => {
    const child = holdBackForward(carried, boxPort, h.back.doorPort, deps.spawn);
    h.child = child;
    if (h.released) child.release();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([child.up, new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(backSlowLine(h.login.ssh))), upMs)))]);
      return child;
    } catch (e) {
      child.release();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  /** The box's place file names the new port where it named the old one; a file of another wsp's is left alone. */
  const rewrite = async (reach: SshReach, h: Held, boxPort: number): Promise<void> => {
    const path = placeDaemonPaths(h.home).placeFile;
    const file = parsePlaceFile((await transport(reach, heldPlaceScript(h.home), { timeoutMs: SSH_DIAL_MS })).stdout);
    if (file === undefined || keyFingerprint(file.hostPublicKey) !== deps.hostKey) return;
    const from = backUrl(h.back.boxPort);
    const hostUrls = file.hostUrls.includes(from) ? file.hostUrls.map(url => (url === from ? backUrl(boxPort) : url)) : [...file.hostUrls, backUrl(boxPort)];
    const next = `${path}.wsp-back`;
    const script = `umask 077 && cat > ${shellQuote(next)} && chmod ${PLACE_FILE_MODE.toString(8)} ${shellQuote(next)} && mv -f ${shellQuote(next)} ${shellQuote(path)}`;
    const landed = await transport(reach, script, { timeoutMs: SSH_DIAL_MS, stdin: new TextEncoder().encode(placeFileText({ ...file, hostUrls })) });
    if (landed.exitCode !== 0) throw new Error(`${h.login.ssh} did not take the forward's new port into its place file: ${landed.stderr.trim().slice(-SSH_LINE_CAP)}`);
  };

  /** One standing of the forward: the port it was asked at, a fresh one where sshd refused that, and the read of
   * where sshd put it. A port that moved goes into the box's place file before anyone hears of it. */
  const once = async (h: Held): Promise<BackForward> => {
    const reach = reachOf(h.login);
    const carried = await carry(reach);
    let boxPort = h.back.boxPort;
    let child: BackForward;
    try {
      child = await stand(h, carried, boxPort);
    } catch (e) {
      // After a sleep sshd can hold the dead session's listener for minutes, so the port is taken, not refused.
      if (!(e instanceof Error && e.message.includes(FORWARD_REFUSED)) || h.released) throw e;
      boxPort = pickPort();
      child = await stand(h, carried, boxPort);
    }
    try {
      const said = await transport(reach, backBindScript(boxPort), { timeoutMs: SSH_DIAL_MS });
      const binds = backBinds(said.stdout, boxPort);
      const wide = binds.find(at => !isLoopback(at));
      if (binds.length === 0 || wide !== undefined) throw new BackCutError(backBindLine(h.login.ssh, wide));
      if (boxPort !== h.back.boxPort) {
        await rewrite(reach, h, boxPort);
        h.back = { ...h.back, boxPort };
        h.moved?.(h.back);
      }
      return child;
    } catch (e) {
      child.release();
      throw e;
    }
  };

  const sleep = (h: Held, ms: number): Promise<void> =>
    new Promise(done => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      h.wake = () => {
        clearTimeout(timer);
        done();
      };
    });

  /** Stands the forward, waits for it to end, and stands it again, until it is released or a refusal says trying
   * again would change nothing. */
  const keep = async (h: Held, first: { resolve: (back: PlaceBack) => void; reject: (e: Error) => void }): Promise<void> => {
    let attempt = 0;
    let firstTry = true;
    while (!h.released) {
      attempt += 1;
      const started = now();
      try {
        const child = await once(h);
        if (firstTry) first.resolve(h.back);
        const said = await child.ended;
        if (h.released) return;
        log(`the forward back from ${h.login.ssh} ended: ${said}; wsp makes it again`);
        h.said = undefined;
        if (now() - started > BACK_SETTLED_MS) attempt = 0;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (firstTry) first.reject(error);
        if (h.released) return;
        if (error instanceof BackCutError) {
          log(error.message);
          held.delete(h.login.ssh);
          h.released = true;
          return;
        }
        // Said once per reason rather than once per try: a box that is off for a day would otherwise fill the log.
        if (!firstTry && error.message !== h.said) log(`the forward back from ${h.login.ssh} did not stand: ${error.message}`);
        h.said = error.message;
      }
      firstTry = false;
      await sleep(h, waitMs(attempt));
    }
  };

  const release = (login: PlaceLogin): void => {
    const h = held.get(login.ssh);
    if (h === undefined) return;
    held.delete(login.ssh);
    h.released = true;
    h.child?.release();
    h.wake?.();
  };

  return {
    hold(login, back, on, moved) {
      const standing = held.get(login.ssh);
      if (standing !== undefined) {
        if (moved !== undefined) standing.moved = moved;
        return standing.first.then(() => standing.back);
      }
      let settle!: { resolve: (back: PlaceBack) => void; reject: (e: Error) => void };
      const first = new Promise<PlaceBack>((resolve, reject) => (settle = { resolve, reject }));
      first.catch(() => {});
      const h: Held = { login, back, home: on.home, ...(moved !== undefined ? { moved } : {}), released: false, first };
      held.set(login.ssh, h);
      void keep(h, settle);
      return first;
    },
    release,
    close() {
      for (const h of [...held.values()]) release(h.login);
    },
  };
}
