// SPDX-License-Identifier: AGPL-3.0-only
// What every places file shares: a fake host to join, a fake service manager, the leave under a case's own home
// and the cleanup after each case. Its hooks register at the top of the file that imports it, before that file's own.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { joinToken, MCP_ID_PREFIX, placeDaemonPaths, placeLinkTranscript, placeProvisionPaths, wsUrlOf } from "@wsp/protocol";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret, type Seal } from "@wsp/runtime";
import { keyFingerprint, sshWordReach, type SshLocalRun } from "@wsp/engine";
import { PLACE_FOUND_END, RUNTIME_ROOT, WSP_WORKSPACE_APPARMOR_PATH } from "@wsp/protocol";
import { addCommand, joinCommand, leaveCommand as leaveCommandHere } from "../src/places.js";
import { sweepPlace as sweepPlaceHere, type PlaceSweepOptions } from "../src/place-report.js";
import { SERVICE_MANAGERS, type RunResult, type ServiceManager, type ServiceRunner, type ServiceUnit } from "../src/service.js";
import { sha256sumBin } from "../../engine/test/sha256sum-bin.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

/** The leave as a case runs it: the workspace profile it takes off is one under the case's own home unless the case
 * names another, since a suite run as root otherwise takes the machine's own profile off it. */
const sweepPlace = (opts: PlaceSweepOptions = {}): ReturnType<typeof sweepPlaceHere> =>
  sweepPlaceHere({ ...(opts.home === undefined ? {} : { apparmorProfile: join(opts.home, "etc-apparmor.d", "wsp-workspace"), tools: toolsUnder(opts.home), systemRoot: join(opts.home, "system") }), ...opts });

/** wsp's install folder and the folder its commands are linked into, under a case's own home, for the same reason. */
const toolsUnder = (home: string): { prefix: string; links: string } => ({ prefix: join(home, "opt-wsp"), links: join(home, "usr-local-bin") });

/** `wsp leave` as a case runs it, with the same profile under the case's own home. */
const leaveCommand = (io: Parameters<typeof leaveCommandHere>[0], args: readonly string[], deps: NonNullable<Parameters<typeof leaveCommandHere>[2]>, flags?: Parameters<typeof leaveCommandHere>[3]): ReturnType<typeof leaveCommandHere> =>
  leaveCommandHere(io, args, { apparmorProfile: join(deps.home, "etc-apparmor.d", "wsp-workspace"), tools: toolsUnder(deps.home), systemRoot: join(deps.home, "system"), ...deps }, flags);

/** The record an add leaves where nothing it would take stood before it: whole, and naming nothing. */
function addFoundNothing(home: string): void {
  mkdirSync(placeDaemonPaths(home).wsp, { recursive: true });
  writeFileSync(placeDaemonPaths(home).placeFound, `${PLACE_FOUND_END}\0`);
}

/** The machine's own profile as the file found it, which every case leaves exactly as it was. */
const MACHINES_PROFILE = existsSync(WSP_WORKSPACE_APPARMOR_PATH) ? readFileSync(WSP_WORKSPACE_APPARMOR_PATH) : undefined;
/** The machine's own runtime folder as the file found it: a leave run as root here takes it unless a case names another. */
const MACHINES_RUNTIME = existsSync(RUNTIME_ROOT) ? readdirSync(RUNTIME_ROOT).sort() : undefined;
afterAll(() => {
  expect(existsSync(WSP_WORKSPACE_APPARMOR_PATH) ? readFileSync(WSP_WORKSPACE_APPARMOR_PATH) : undefined, "a case touched this machine's own workspace profile").toEqual(MACHINES_PROFILE);
  expect(existsSync(RUNTIME_ROOT) ? readdirSync(RUNTIME_ROOT).sort() : undefined, "a case took this machine's own runtime folder").toEqual(MACHINES_RUNTIME);
});

const dirs: string[] = [];
const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${name}-`));
  dirs.push(dir);
  return dir;
};

/** The list the recipe's job leaves beside itself, as the contract fixture holds it: one line per path wsp landed
 * in an agent's home on that computer, the bytes that travelled and the bytes standing after the round. The
 * daemon's own case builds its fake home from the same file. */
const LEDGER_FIXTURE = fileURLToPath(new URL("../../../daemon/fixtures/contract/landed.tsv", import.meta.url));

/** The bytes of the three files that ledger names, in its order: what the run that landed them put there, so the
 * read that hashes a file against the ledger's third column answers for the ones nothing has rewritten. */
const LANDED_BYTES = ["the skill wsp landed\n", '{"wsp":true}\n', "wsp = true\n"];

/** That ledger as rows of a path and the bytes wsp left at it, with each hash it holds read against the bytes
 * written here, so a fixture and a case cannot drift apart quietly. */
function ledgerRows(): { rel: string; bytes: string }[] {
  const lines = readFileSync(LEDGER_FIXTURE, "utf8").split("\n").filter(line => line.trim() !== "");
  expect(lines.length, "landed.tsv holds a line per set of bytes here").toBe(LANDED_BYTES.length);
  return lines.map((line, index) => {
    const fields = line.split("\t");
    const bytes = LANDED_BYTES[index]!;
    expect(fields[2], `landed.tsv names bytes for ${fields[0]} that this file does not write`).toBe(createHash("sha256").update(bytes).digest("hex"));
    return { rel: fields[0]!, bytes };
  });
}

/** A home with that ledger and what it names: every file but the last as wsp left it, the last one rewritten by
 * the person since, and one file of theirs beside them that no line names. */
function homeWithLandedFiles(name: string): { home: string; rows: { rel: string; bytes: string }[] } {
  const home = tmp(name);
  const rows = ledgerRows();
  const at = placeProvisionPaths(home);
  mkdirSync(at.dir, { recursive: true });
  writeFileSync(at.landed, readFileSync(LEDGER_FIXTURE));
  for (const [index, row] of rows.entries()) {
    const path = join(home, row.rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, index + 1 === rows.length ? "the person wrote this\n" : row.bytes);
  }
  writeFileSync(join(home, ".claude", "theirs.md"), "mine\n");
  // A line the servers step wrote: a key in an agent's own file, no path under the home, and the digest of the
  // entry wsp left under that name. Nothing on the disk stands at it and nothing is taken for it.
  appendFileSync(at.landed, `${MCP_ID_PREFIX}claude/context7\tdeadbeef\tdeadbeef\n`);
  return { home, rows };
}

/** sh with a sha256sum to find: the script the leave runs is the engine's own and hashes the bytes with it, and a
 * Mac carries no coreutils one on every release. */
function shWithSha256sum(): (script: string) => string {
  const bin = sha256sumBin();
  dirs.push(bin);
  return script => execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
}

/** Every manager command answered as if it worked, with what was asked kept. */
function fakeRunner(): { run: ServiceRunner; ran: string[][]; holds: boolean } {
  const state = { run: (() => Promise.resolve({ code: 0, output: "" })) as ServiceRunner, ran: [] as string[][], holds: true };
  state.run = (argv): Promise<RunResult> => {
    state.ran.push([...argv]);
    // `holds` is the one answer a stop turns on: a manager that says it has the unit is asked to unload it.
    if (argv.includes("print") || argv.includes("is-enabled")) return Promise.resolve({ code: state.holds ? 0 : 113, output: state.holds ? "" : "could not find service" });
    return Promise.resolve({ code: 0, output: "" });
  };
  return state;
}

interface FakeHost {
  url: string;
  publicKey: string;
  /** The join frames it saw, so a test can read the report and the key a computer sent. */
  frames: Record<string, unknown>[];
}

async function fakeHost(opts: { wrongKey?: boolean; strangerKey?: boolean; refuse?: string; hostUrls?: string[]; unreadable?: boolean } = {}): Promise<FakeHost> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const other = generateKeyPairSync("ed25519");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const frames: Record<string, unknown>[] = [];
  wss.on("connection", ws => {
    ws.on("error", () => {});
    /** Set once this host has answered the join: from the prove on the link is sealed both ways. */
    let seal: Seal | undefined;
    ws.on("message", raw => {
      const frame = JSON.parse(seal === undefined ? String(raw) : seal.unseal(raw as Uint8Array)) as Record<string, unknown>;
      frames.push(frame);
      if (frame["op"] === "place.join") {
        if (opts.refuse !== undefined) {
          ws.send(JSON.stringify({ id: frame["id"], ok: false, error: opts.refuse, kind: "auth" }));
          ws.close(4401, "unauthorized");
          return;
        }
        if (opts.unreadable === true) {
          ws.send(JSON.stringify({ id: frame["id"], ok: true }));
          return;
        }
        const placeId = "p_ab12cd34ab12cd34";
        const nonce = Buffer.alloc(32, 5).toString("base64");
        const mine = freshEphemeral();
        const bytes = placeLinkTranscript("host", placeId, String(frame["nonce"]), nonce, { challenger: String(frame["ephemeral"]), answerer: mine.publicKey });
        // A host whose signature is made by a key other than the one it sent is the one thing a join must refuse.
        // A stranger answering at the host's address holds a key of its own and signs the transcript with it
        // perfectly well: what tells it from the host is which key it is, not whether it can sign.
        const answering = opts.strangerKey === true ? other.publicKey.export({ type: "spki", format: "der" }).toString("base64") : key.publicKey;
        const signature = sign(null, bytes, opts.wrongKey === true || opts.strangerKey === true ? other.privateKey : createPrivateKey(key.pem)).toString("base64");
        ws.send(
          JSON.stringify({
            id: frame["id"],
            ok: true,
            placeId,
            hostPublicKey: answering,
            nonce,
            signature,
            ephemeral: mine.publicKey,
            hostName: "zingzy-mbp",
          }),
        );
        seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, String(frame["ephemeral"])), placeId), "host");
        return;
      }
      if (frame["op"] === "place.prove") {
        // The token the window asked for rides the sealed reply to the prove, since the code that bought it
        // crossed on this frame and no earlier.
        ws.send(seal!.seal(JSON.stringify({ id: frame["id"], ok: true, ...(frame["client"] === undefined ? {} : { device: { deviceId: "d_1", deviceToken: "dev-token" } }) })));
      }
    });
  });
  const port = await new Promise<number>((done, fail) => {
    wss.once("listening", () => done((wss.address() as { port: number }).port));
    wss.once("error", fail);
  });
  return { url: `http://127.0.0.1:${port}`, publicKey: key.publicKey, frames };
}

/** The systemd this computer's real one stands in for in these tests: the module as it is, with the machine's unit
 * folder under the test's own home. Where a place's unit actually lands is pinned on the module itself, in
 * service.test.ts; nothing here writes into the real /etc. */
const unitsUnder = (home: string): ServiceManager => {
  // The machine's own folder moved under this test's home; a login's folder already sits under the home it is handed.
  const here = (unit: ServiceUnit): ServiceUnit => (unit.path.startsWith("/etc/") ? { name: unit.name, path: join(home, "etc-systemd-system", unit.name) } : unit);
  return {
    ...SERVICE_MANAGERS.systemd,
    unit: at => here(SERVICE_MANAGERS.systemd.unit(at)),
    held: at => SERVICE_MANAGERS.systemd.held(at).map(held => ({ ...held, unit: here(held.unit) })),
  };
};

/** The one token a join line carries, for the host a test started: the code that host will spend and the
 * fingerprint of the key it will prove. */
const codeFor = (host: FakeHost, code: string): string => joinToken(code, keyFingerprint(host.publicKey));

/** A token naming a key no host in these tests holds, for the dials that reach nothing at all. */
const NOWHERE_CODE = joinToken("X", `SHA256:${"a".repeat(43)}`);

const joinDepsFor = (home: string, runner: ServiceRunner): Parameters<typeof joinCommand>[3] => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: runner,
  platform: "linux",
  home,
  now: () => 0,
  manager: unitsUnder(home),
  uid: 0,
});

/** Every dependency the two host-side words take, with the provider check answered here: a unit test calls no
 * provider. The dial is the one road that reaches a host, and the tests that take it hand their own. */
/** The sign-in on a computer you own, answered here: a unit test opens no pty on a box. A test that means to
 * exercise it hands its own signIn and reads what it was given. */
/** An ssh client config holding one block, spoo renamed to its address with root as its user and the port given,
 * and nothing else: every other word comes back as its own hostname, which is what `ssh -G` prints for a name no
 * block renames. Nothing here runs the real client. */
const spooConfig =
  (port = 22): SshLocalRun =>
  async (_file, args) => {
    const word = args.at(-1)!;
    const stdout = word === "spoo" ? `user root\nhostname 178.156.161.168\nport ${port}\n` : `user dev\nhostname ${word}\nport 22\n`;
    return { exitCode: 0, stdout, stderr: "" };
  };

const noBoxSignIn = {
  sshWord: (word: string, o: { port?: number; keyPath?: string }) => sshWordReach(word, o, spooConfig()),
  // Every road that is not the first dial of a stranger reads a computer this Mac's client has already met, and
  // none of them reaches the real client: a scan leaves this computer.
  heldHostKey: async (): Promise<string | undefined> => "ssh-ed25519 SHA256:held",
  offeredHostKey: async (): Promise<{ key?: string; stoppedBy?: string }> => ({ key: "ssh-ed25519 SHA256:offered" }),
  terminal: { input: new PassThrough() as never, output: new PassThrough() as never },
  open: async () => false,
  placeLink: async () => ({ link: { op: async () => ({ ok: true }), onEvent: () => () => {} }, close: async () => undefined }),
  signIn: async () => ({ signedIn: false, said: "nothing signs in on this road" }),
};

const systemPlaceDeps: NonNullable<Parameters<typeof addCommand>[4]> = {
  dial: () => Promise.reject(new Error("no host is dialled on this road")),
  now: () => 0,
  run: fakeRunner().run,
  platform: "linux",
  checkKey: async () => ({ state: "taken" }),
  ...noBoxSignIn,
};

const opts = (home: string, env: Record<string, string | undefined> = {}): Parameters<typeof addCommand>[1] => ({
  statePath: join(home, "state.json"),
  home,
  env: { HOME: home, WSP_HOME: home },
  providerEnv: env,
});

export { sweepPlace, toolsUnder, leaveCommand, addFoundNothing, MACHINES_PROFILE, dirs, servers, tmp, LEDGER_FIXTURE, LANDED_BYTES, ledgerRows, homeWithLandedFiles, shWithSha256sum, fakeRunner, fakeHost, unitsUnder, codeFor, NOWHERE_CODE, joinDepsFor, spooConfig, noBoxSignIn, systemPlaceDeps, opts };
export type { FakeHost };
