// SPDX-License-Identifier: AGPL-3.0-only
// The outbound half of a place: this computer dials its host instead of
// listening for it, proves who it is with the ed25519 key the host learned at
// join, and then serves that one socket exactly as it serves an inbound one.
// Nothing here opens a port. The encodings both sides sign and send are pinned
// in the protocol (PlaceNonce, PlacePublicKey, PlaceSignature) and the bytes
// they sign come from placeLinkTranscript, so this file holds the place's half
// of the handshake and no rule of its own about how it is spelled.
import { createPublicKey, createPrivateKey, randomBytes, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  NO_PLACE_FILE_LINE,
  PLACE_FILE_MODE,
  PLACE_LINK_NONCE_BYTES,
  PlaceAuthReply,
  authUnreadableLine,
  dialFailedLine,
  dialTimedOutLine,
  dialUnansweredLine,
  hostKeyRefusal,
  hostQuietLine,
  hostRefusedLine,
  linkedLine,
  notAFrameLine,
  parsePlaceFile,
  placeFileText,
  placeLinkTranscript,
  wsUrlOf,
  type PlaceFile,
  type PlaceReport,
} from "@wsp/protocol";
import WebSocket from "ws";

/** The place file as it stands, or nothing when this computer is no place. The shape, the parse and the mode are
 * the protocol's, since the join writes this file on one side of the wire and this agent reads it on the other.
 *
 * The other copy of these two lines is `readPlaceFile` and `writePlaceFile` in `packages/host/src/place-report.ts`.
 * The boundary that forces it: the host may never import this package eagerly, because its module scope dlopens a
 * native pty, and the protocol, which both sides do import, is bundled into the browser and can hold no fs call.
 * What could drift, the shape and the mode, is in the protocol; what is copied is the read and the write of a file. */
export function readPlaceFile(path: string): PlaceFile | undefined {
  try {
    return parsePlaceFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Writes the place file at the one mode it is ever kept at; the folder is made first, since a fresh computer has none. */
export function writePlaceFile(path: string, file: PlaceFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, placeFileText(file), { mode: PLACE_FILE_MODE });
  chmodSync(path, PLACE_FILE_MODE);
}

/** This place's signature over the bytes both sides build from one function; ed25519 takes no digest name, which is
 * what the null says.
 *
 * The other copy of this pair is `signPlaceBytes` and `verifyPlaceBytes` in `packages/runtime/src/places.ts`, which
 * is the host's half. The same boundary forces it: the protocol is the one package both sides import and it is
 * bundled into the browser, so it can hold no node crypto. What could drift, the bytes that are signed and the
 * encodings they are sent in, is in the protocol (`placeLinkTranscript`, `PlaceSignature`, `PlacePublicKey`). */
export function signPlaceBytes(privateKeyPem: string, bytes: Uint8Array): string {
  return signBytes(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether the key this computer pinned at join made this signature. A key that will not even parse is a refusal
 * rather than a throw: the answer came off the wire. */
export function verifyPlaceBytes(publicKeyBase64: string, bytes: Uint8Array, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return verifyBytes(null, bytes, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** What this computer says about itself on every link. Which address the link reached and which port this daemon
 * bound are not the caller's to know before the dial, so the link and the daemon fill those two in. */
export type PlaceSelfReport = Omit<PlaceReport, "dialed" | "daemonPort">;

/** One op answered on the socket the place opened, with the frame it arrived on: the handler belongs to the road
 * that owns the act, not to the daemon's switch. */
export type LinkOp = (msg: Record<string, unknown>) => Promise<object>;

/** The ops a socket the place opened answers that no inbound socket does: taking this computer out of a wsp, and
 * whatever else the road that dialled out registers. */
export type LinkOps = Readonly<Record<string, LinkOp>>;

export interface PlaceLinkOptions {
  /** The place file to read on every attempt, so a leave or a re-join is picked up without a restart. */
  file: string;
  report(): Promise<PlaceSelfReport>;
  /** Sweeps wsp off this computer and answers what it took; run when the host asks over the link. */
  onLeave(): Promise<string[]>;
  /** What else this computer answers on the socket it opened, by op name; the machine ops of a computer that serves
   * a Docker daemon ride here. Absent leaves the link with the leave op alone. */
  ops?: LinkOps;
  /** The port this daemon bound, filled in by the daemon that owns the link. */
  daemonPort?: number;
  backoffMs?: (attempt: number) => number;
  log?: (line: string) => void;
  /** How a socket is opened; the ws client unless a test hands its own. */
  dial?: (url: string) => WebSocket;
  /** How long one address gets to answer the connect and each handshake frame. */
  connectTimeoutMs?: number;
  /** How long a link may carry no frame at all before it is cut and redialled. */
  quietMs?: number;
  /** How long a refused link waits before it dials again: the person removed this place, or the host rotated. */
  refusedRetryMs?: number;
  /** The jitter draw; Math.random unless a test pins it. */
  random?: () => number;
  now?: () => number;
  /** What ends the agent once a leave has been answered; the process unless a test hands its own. */
  exit?: () => void;
}

/** Where the link is: dialling its addresses in turn, holding one, or told by the host that this place is not one
 * it knows, which is a wait of minutes rather than seconds. */
export type PlaceLinkStatus = "dialing" | "linked" | "refused";

/** How long each address gets to answer the connect and each frame of the handshake. */
const CONNECT_MS = 10_000;
/** How long a link may carry no frame before it is cut: the host pings every ten seconds, so three missed beats. */
const QUIET_MS = 30_000;
/** How long a refused link waits. The host holds no such place, so nothing changes until a person acts. */
const REFUSED_RETRY_MS = 10 * 60_000;
/** A link that stood this long was a working link, so the next redial starts from the bottom of the backoff. */
const SETTLED_MS = 60_000;

/** The wait before attempt n: two seconds doubling to thirty. */
export function placeBackoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

/** Four fifths to six fifths of the wait, so a hundred places that lost one host do not all come back at once. */
const jittered = (ms: number, draw: number): number => Math.round(ms * (0.8 + 0.4 * draw));

/** The link a place holds to its host: it dials, proves, hands the socket over to be served, and dials again when
 * it goes. One socket at a time, and nothing of this computer's is listening for the host to arrive. */
export class PlaceLink {
  private state: PlaceLinkStatus = "dialing";
  private socket: WebSocket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private quietTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private linkedAt = 0;
  private stopped = false;
  private readonly opts: PlaceLinkOptions;
  private readonly serve: (ws: WebSocket, ops: LinkOps) => void;

  constructor(opts: PlaceLinkOptions, serve: (ws: WebSocket, ops: LinkOps) => void) {
    this.opts = opts;
    this.serve = serve;
    this.schedule(0);
  }

  status(): PlaceLinkStatus {
    return this.state;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    this.timer = undefined;
    this.quietTimer = undefined;
    this.socket?.close(1000, "place agent stopping");
    this.socket = undefined;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.attemptOnce();
    }, ms);
  }

  /** One pass over every address in the place file. An address that refuses the connect or says nothing in time is
   * skipped and the next one tried; a host that says this place is not one it knows ends the pass and the wait
   * afterwards is minutes. */
  private async attemptOnce(): Promise<void> {
    if (this.stopped) return;
    this.attempt++;
    const file = readPlaceFile(this.opts.file);
    if (file === undefined) {
      this.log(NO_PLACE_FILE_LINE);
      this.schedule(this.wait(REFUSED_RETRY_MS));
      return;
    }
    for (const url of file.hostUrls) {
      if (this.stopped) return;
      const tried = await this.handshake(file, url);
      if (tried === "linked") return;
      if (tried === "refused") {
        this.state = "refused";
        this.schedule(this.wait(this.opts.refusedRetryMs ?? REFUSED_RETRY_MS));
        return;
      }
    }
    this.state = "dialing";
    this.schedule(this.wait((this.opts.backoffMs ?? placeBackoffMs)(this.attempt)));
  }

  private wait(ms: number): number {
    return jittered(ms, (this.opts.random ?? Math.random)());
  }

  /** One address: open, auth, verify the host, prove, hand over. Answers what happened, so the pass above knows
   * whether to try the next address, to stop for minutes, or that it is done. */
  private handshake(file: PlaceFile, url: string): Promise<"linked" | "skipped" | "refused"> {
    const connectMs = this.opts.connectTimeoutMs ?? CONNECT_MS;
    return new Promise(done => {
      let ws: WebSocket;
      try {
        ws = (this.opts.dial ?? ((at: string) => new WebSocket(wsUrlOf(at))))(url);
      } catch (e) {
        this.log(dialFailedLine(url, e instanceof Error ? e.message : String(e)));
        done("skipped");
        return;
      }
      let settled = false;
      let refusalLine: string | undefined;
      const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
      const deadline = setTimeout(() => {
        this.log(dialTimedOutLine(url, Math.round(connectMs / 1000)));
        finish("skipped", true);
      }, connectMs);
      const finish = (outcome: "linked" | "skipped" | "refused", cut: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        ws.off("message", onFrame);
        if (cut) ws.close(1000, "place link ending its attempt");
        done(outcome);
      };
      const onFrame = (raw: WebSocket.RawData): void => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          this.log(notAFrameLine(url));
          finish("skipped", true);
          return;
        }
        if (frame["ok"] !== true) {
          // The host answered the handshake with a refusal: this place is not one it holds, or its key moved. The
          // sentence is the host's own and the 4401 that follows carries it too.
          refusalLine = String(frame["error"] ?? "the host refused this place");
          this.log(hostRefusedLine(url, refusalLine));
          finish("refused", true);
          return;
        }
        if (frame["id"] === 1) {
          const reply = PlaceAuthReply.safeParse(frame);
          if (!reply.success) {
            this.log(authUnreadableLine(url, reply.error.message));
            finish("skipped", true);
            return;
          }
          const proved =
            reply.data.hostPublicKey === file.hostPublicKey &&
            verifyPlaceBytes(file.hostPublicKey, placeLinkTranscript("host", file.placeId, nonce, reply.data.nonce), reply.data.signature);
          if (!proved) {
            // Nothing of this computer's has been sent yet: the report and the place's own signature are the next
            // frame, and the attempt ends before it.
            this.log(hostKeyRefusal(url));
            finish("skipped", true);
            return;
          }
          void this.prove(file, url, ws, reply.data.nonce, nonce).then(
            () => {
              // Served synchronously below, before this promise settles: the socket is ordered, so the host's first
              // daemon frame cannot arrive before the listener that answers it is on.
            },
            (e: unknown) => {
              this.log(hostRefusedLine(url, e instanceof Error ? e.message : String(e)));
              finish("skipped", true);
            },
          );
          return;
        }
        if (frame["id"] === 2) {
          // The prove landed. The socket stops being the handshake's and becomes this computer's daemon.
          finish("linked", false);
          this.hold(ws, url);
        }
      };
      ws.on("error", () => {});
      ws.on("message", onFrame);
      ws.once("close", () => {
        if (refusalLine !== undefined) {
          finish("refused", false);
          return;
        }
        // Logged here rather than only at the deadline: an address that refuses the connect answers at once, and an
        // attempt that says nothing about it leaves a person reading one address in a log of two.
        if (!settled) this.log(dialUnansweredLine(url));
        finish("skipped", false);
      });
      ws.once("open", () => {
        ws.send(JSON.stringify({ id: 1, op: "place.auth", placeId: file.placeId, nonce }));
      });
    });
  }

  private async prove(file: PlaceFile, url: string, ws: WebSocket, hostNonce: string, myNonce: string): Promise<void> {
    const pem = readFileSync(file.keyPath, "utf8");
    const report: PlaceReport = {
      ...(await this.opts.report()),
      dialed: url,
      ...(this.opts.daemonPort !== undefined ? { daemonPort: this.opts.daemonPort } : {}),
    };
    const signature = signPlaceBytes(pem, placeLinkTranscript("place", file.placeId, hostNonce, myNonce));
    ws.send(JSON.stringify({ id: 2, op: "place.prove", signature, report }));
  }

  /** The socket is this place's link from here: the daemon serves it, its own ops ride it, and a link that carries
   * no frame at all is cut so the redial can find a host that is actually there. */
  private hold(ws: WebSocket, url: string): void {
    this.state = "linked";
    this.socket = ws;
    this.linkedAt = (this.opts.now ?? Date.now)();
    this.log(linkedLine(url));
    const quietMs = this.opts.quietMs ?? QUIET_MS;
    const quiet = (): void => {
      if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => {
        this.log(hostQuietLine(url, Math.round(quietMs / 1000)));
        ws.close(1000, "the host went quiet");
      }, quietMs);
    };
    ws.on("message", quiet);
    quiet();
    ws.once("close", () => {
      if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
      if (this.socket === ws) this.socket = undefined;
      if (this.stopped) return;
      this.state = "dialing";
      // A link that stood a minute was a working link: the next one starts from the bottom of the backoff rather
      // than from wherever a laptop that slept for an hour left it.
      if ((this.opts.now ?? Date.now)() - this.linkedAt > SETTLED_MS) this.attempt = 0;
      this.schedule(this.wait((this.opts.backoffMs ?? placeBackoffMs)(this.attempt + 1)));
    });
    this.serve(ws, { ...this.opts.ops, "place.leave": () => this.leave() });
  }

  /** The host asked this computer to leave. The sweep runs here, the reply names what it took, and the agent ends
   * after the reply is on the wire: its unit is already unloaded by the sweep, so nothing brings it back. */
  private async leave(): Promise<object> {
    const swept = await this.opts.onLeave();
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    setTimeout(() => (this.opts.exit ?? (() => process.exit(0)))(), 0);
    return { swept };
  }
}
