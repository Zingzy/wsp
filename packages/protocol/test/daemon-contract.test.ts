// SPDX-License-Identifier: AGPL-3.0-only
// The contract every daemon speaking this wire is held to, as one fixture set
// under daemon/fixtures/contract: frames the schemas here must take and refuse,
// one file pair per op and per event type, and the words and numbers the
// daemon emits that a client or a test matches on. This side is the source:
// the words and numbers are regenerated from this package's exports and must
// equal the committed files, and a daemon written in another language checks
// its own constants and types against the same files, never against a build
// of this package.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZodLiteral, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import {
  AUTH_DEADLINE_MS,
  DAEMON_AUTH_DEADLINE_PASSED,
  DAEMON_DEFAULT_HOST,
  DAEMON_DEFAULT_PORT,
  DAEMON_FIRST_FRAME_NOT_AUTH,
  DAEMON_INVALID_JSON,
  DAEMON_NICE,
  DAEMON_NO_TOKEN,
  DAEMON_OOM_SCORE_ADJ,
  DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  DAEMON_ROOTS_PATH,
  DAEMON_TOKEN_PATH,
  DAEMON_TOKEN_REFUSED,
  DAEMON_VERSION,
  DaemonAuthRequest,
  DaemonEvent,
  DaemonRequest,
  EXEC_BODY_MAX,
  MachineLinkRequest,
  EXEC_DEADLINE_EXIT,
  EXEC_OUTPUT_MAX,
  EXEC_TIMEOUT_DEFAULT_MS,
  FS_LIST_CAP_ENTRIES,
  FS_READ_CAP_BYTES,
  GIT_DIFF_CAP_BYTES,
  GUEST_DAEMON_DIR,
  GUEST_INBOX_DIR,
  GUEST_MANIFEST_PATH,
  HTTP_URL_MAX,
  NO_PLACE_FILE_LINE,
  NOT_ON_THIS_KIND,
  NOT_ON_THIS_ROAD,
  OPEN_SHIM_PATH,
  OPEN_SOCKET_PATH,
  PID_MAX,
  PLACE_LINK_NONCE_BYTES,
  PORT_COMMAND_BYTES,
  PRE_AUTH_MAX_BYTES,
  PROC_CAP,
  PROC_CMDLINE_BYTES,
  PROC_SAMPLER_STARTED,
  PROC_SAMPLER_STOPPED,
  PTY_SCROLLBACK_CAP_BYTES,
  PlaceAuthRequest,
  PlaceProveRequest,
  SYS_SAMPLER_STARTED,
  SYS_SAMPLER_STOPPED,
  TUNNEL_CAP,
  WORK_OOM_SCORE_ADJ,
  XDG_OPEN_PATH,
  authUnreadableLine,
  daemonListeningLine,
  dialFailedLine,
  dialTimedOutLine,
  dialUnansweredLine,
  hostKeyRefusal,
  hostQuietLine,
  hostRefusedLine,
  linkedLine,
  notAFrameLine,
  portScopeRefusal,
  unknownOpLine,
  workScoreLine,
} from "../src/index.js";

const CONTRACT = fileURLToPath(new URL("../../../daemon/fixtures/contract/", import.meta.url));

/** The frames a file holds, which is always an array with something in it. */
function frames(dir: string, name: string): unknown[] {
  const path = join(CONTRACT, dir, name);
  const held = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(held) || held.length === 0) throw new Error(`${path} must hold a non-empty array of frames`);
  return held;
}

/** The op or type names a discriminated union takes, off its options. */
const namesOf = (union: { options: ZodObject<ZodRawShape>[] }, key: string): string[] =>
  union.options
    .map(option => {
      const literal = option.shape[key];
      if (!(literal instanceof ZodLiteral)) throw new Error(`${key} is not a literal on every option`);
      return String(literal.value);
    })
    .sort();

/** The op names with a file pair under frames, off the files. */
const filed = (dir: string): string[] => [...new Set(readdirSync(join(CONTRACT, dir)).map(f => f.replace(/\.(accept|reject)\.json$/, "")))].sort();

/** Which schema reads a frame by its op: every op the daemon answers inbound is one DaemonRequest option, the auth
 * frame is its own, the two the place sends outward to its host are theirs, and the machine ops the host sends a
 * place over the link are the link's own union. */
const OUTBOUND: Record<string, ZodTypeAny> = { auth: DaemonAuthRequest, "place.auth": PlaceAuthRequest, "place.prove": PlaceProveRequest };
const schemaFor = (op: string): ZodTypeAny => OUTBOUND[op] ?? (op.startsWith("machine.") ? MachineLinkRequest : DaemonRequest);

describe("every op and every event has its accept and reject frames", () => {
  it("names one file pair per op the daemon answers, per machine op on the link, plus auth and the two frames a place sends its host", () => {
    expect(filed("frames")).toEqual([...namesOf(DaemonRequest, "op"), ...namesOf(MachineLinkRequest, "op"), ...Object.keys(OUTBOUND)].sort());
  });

  it("names one file pair per event type the daemon pushes", () => {
    expect(filed("events")).toEqual(namesOf(DaemonEvent, "type"));
  });

  it("has both halves of every pair", () => {
    for (const dir of ["frames", "events"]) {
      for (const name of filed(dir)) {
        for (const half of ["accept", "reject"]) expect(existsSync(join(CONTRACT, dir, `${name}.${half}.json`)), `${dir}/${name}.${half}.json`).toBe(true);
      }
    }
  });
});

describe("the schemas take every accept frame and refuse every reject frame", () => {
  for (const op of filed("frames")) {
    it(`frames/${op}`, () => {
      const schema = schemaFor(op);
      for (const frame of frames("frames", `${op}.accept.json`)) {
        const parsed = schema.safeParse(frame);
        expect(parsed.success, `${op} must accept ${JSON.stringify(frame).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        // A frame under an op's file is that op's frame: the discriminant is what the file is named after.
        expect((frame as { op: string }).op).toBe(op);
      }
      for (const frame of frames("frames", `${op}.reject.json`)) {
        expect(schema.safeParse(frame).success, `${op} must refuse ${JSON.stringify(frame).slice(0, 200)}`).toBe(false);
      }
    });
  }

  for (const type of filed("events")) {
    it(`events/${type}`, () => {
      for (const event of frames("events", `${type}.accept.json`)) {
        const parsed = DaemonEvent.safeParse(event);
        expect(parsed.success, `${type} must accept ${JSON.stringify(event).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        expect((event as { type: string }).type).toBe(type);
      }
      for (const event of frames("events", `${type}.reject.json`)) {
        expect(DaemonEvent.safeParse(event).success, `${type} must refuse ${JSON.stringify(event).slice(0, 200)}`).toBe(false);
      }
    });
  }
});

/** A sentence with a value in it is kept as its template: the braces name what the daemon fills in. */
const words = (): Record<string, string> => ({
  tokenRefused: DAEMON_TOKEN_REFUSED,
  firstFrameNotAuth: DAEMON_FIRST_FRAME_NOT_AUTH,
  preAuthBytesExceeded: DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  authDeadlinePassed: DAEMON_AUTH_DEADLINE_PASSED,
  invalidJson: DAEMON_INVALID_JSON,
  noToken: DAEMON_NO_TOKEN,
  unknownOp: unknownOpLine("{op}"),
  portScopeRefusal: portScopeRefusal("{port}"),
  notOnThisRoad: NOT_ON_THIS_ROAD,
  notOnThisKind: NOT_ON_THIS_KIND,
  hostKeyRefusal: hostKeyRefusal("{url}"),
  listening: daemonListeningLine("{host}", "{port}"),
  sysSamplerStarted: SYS_SAMPLER_STARTED,
  sysSamplerStopped: SYS_SAMPLER_STOPPED,
  procSamplerStarted: PROC_SAMPLER_STARTED,
  procSamplerStopped: PROC_SAMPLER_STOPPED,
  noPlaceFile: NO_PLACE_FILE_LINE,
  linked: linkedLine("{url}"),
  hostQuiet: hostQuietLine("{url}", "{seconds}"),
  dialUnanswered: dialUnansweredLine("{url}"),
  dialTimedOut: dialTimedOutLine("{url}", "{seconds}"),
  dialFailed: dialFailedLine("{url}", "{error}"),
  notAFrame: notAFrameLine("{url}"),
  authUnreadable: authUnreadableLine("{url}", "{error}"),
  hostRefused: hostRefusedLine("{url}", "{refusal}"),
});

const numbers = (): Record<string, number | string> => ({
  daemonVersion: DAEMON_VERSION,
  execBodyMax: EXEC_BODY_MAX,
  execOutputMax: EXEC_OUTPUT_MAX,
  execTimeoutDefaultMs: EXEC_TIMEOUT_DEFAULT_MS,
  execDeadlineExit: EXEC_DEADLINE_EXIT,
  placeLinkNonceBytes: PLACE_LINK_NONCE_BYTES,
  preAuthMaxBytes: PRE_AUTH_MAX_BYTES,
  authDeadlineMs: AUTH_DEADLINE_MS,
  tunnelCap: TUNNEL_CAP,
  fsReadCapBytes: FS_READ_CAP_BYTES,
  fsListCapEntries: FS_LIST_CAP_ENTRIES,
  gitDiffCapBytes: GIT_DIFF_CAP_BYTES,
  ptyScrollbackCapBytes: PTY_SCROLLBACK_CAP_BYTES,
  procCmdlineBytes: PROC_CMDLINE_BYTES,
  portCommandBytes: PORT_COMMAND_BYTES,
  procCap: PROC_CAP,
  pidMax: PID_MAX,
  openBodyMax: HTTP_URL_MAX,
  daemonDefaultHost: DAEMON_DEFAULT_HOST,
  daemonDefaultPort: DAEMON_DEFAULT_PORT,
  daemonTokenPath: DAEMON_TOKEN_PATH,
  daemonRootsPath: DAEMON_ROOTS_PATH,
  guestInboxDir: GUEST_INBOX_DIR,
  guestManifestPath: GUEST_MANIFEST_PATH,
  openShimPath: OPEN_SHIM_PATH,
  xdgOpenPath: XDG_OPEN_PATH,
  openSocketPath: OPEN_SOCKET_PATH,
  guestDaemonDir: GUEST_DAEMON_DIR,
  daemonOomScoreAdj: DAEMON_OOM_SCORE_ADJ,
  daemonNice: DAEMON_NICE,
  workOomScoreAdj: WORK_OOM_SCORE_ADJ,
  workScoreLine: workScoreLine(),
});

describe("the words and numbers are what this package exports", () => {
  for (const [name, regenerate] of [
    ["words.json", words],
    ["numbers.json", numbers],
  ] as const) {
    it(`${name} equals its regeneration`, () => {
      const fresh = regenerate();
      const text = `${JSON.stringify(fresh, null, 2)}\n`;
      const regenerated = join(tmpdir(), `wsp-contract-${name}`);
      writeFileSync(regenerated, text);
      const committed = existsSync(join(CONTRACT, name)) ? (JSON.parse(readFileSync(join(CONTRACT, name), "utf8")) as unknown) : undefined;
      expect(committed, `daemon/fixtures/contract/${name} is behind the protocol. The regenerated file is at ${regenerated}: copy it over daemon/fixtures/contract/${name} and commit it`).toEqual(fresh);
      expect(readFileSync(join(CONTRACT, name), "utf8")).toBe(text);
    });
  }

  it("holds every 4401 reason once, and the listening line names a host and a port", () => {
    const w = words();
    expect(new Set([w["tokenRefused"], w["firstFrameNotAuth"], w["preAuthBytesExceeded"], w["authDeadlinePassed"]]).size).toBe(4);
    expect(w["listening"]).toBe("wsp-daemon listening on {host}:{port}");
    expect(w["unknownOp"]).toBe("unknown op: {op}");
  });
});
