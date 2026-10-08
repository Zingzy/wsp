// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createPublicKey } from "node:crypto";
import type { Server, Socket } from "node:net";
import {
  isPlainPath,
  PendingComputer,
  RecipeFile,
  recipeCanon,
  importantFailures,
  waitLine,
  plural,
  type PlaceApplied,
  type PlaceSetup,
  type PlaceProvisionRow,
  type PlaceSync,
  type PlaceSetupStep,
  type SetupEnd,
  type AgentSignInState,
  type PlaceReport,
} from "@wsp/protocol";
import { SSH_STORE_VARS, plainPath, type ProvisionPlan, type ToolInstall } from "@wsp/engine";
import { CATALOG_AGENTS, keyEnvOf, mintsToken, sharedFileIn, sharedOn } from "@wsp/catalog";
import type { WebSocket } from "ws";
import type { PlaceForward } from "../place-forward.js";
import type { DaemonReach } from "../reach.js";
import type { RecipeChange } from "../recipe-sync.js";
import type { PlaceWiring, PlaceInstalled } from "./types.js";

/** One promise with a bound of its own: a place that took a frame and went quiet fails the call rather than
 * leaving a road waiting on a socket nothing is coming back on. */
export function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} was not answered in ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
    work.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The pair each end of a link proves itself with, the fingerprint a person copies and the signatures over the
 * transcript both ends build: they live in their own package, since the command line holds a host to its key
 * before it sends a token and cannot load this one to do it. Named here too, where every reader of the link
 * already looks for them. */
export { newPlaceKeyPair, signPlaceBytes, verifyPlaceBytes, type PlaceKeyPair } from "@wsp/keys";

/** Whether a public key off the wire is an ed25519 one this host can verify against later. Read before the code is
 * spent, so a key that opens nothing never costs somebody their join code. */
export function readsAsEd25519(publicKeyBase64: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** How long a join that has been answered has to send its prove before this host forgets it was asked. Longer
 * than any handshake and shorter than a code's own life, so nothing a person is still typing is swept. */
export const JOIN_PROVE_MS = 2 * 60_000;

/** The one sentence a join whose key this host cannot verify against is refused with. */
export const PLACE_BAD_KEY_REFUSAL = "that join sent a key this host cannot verify a signature against; a place's key is ed25519, as SPKI DER in base64";

/** The one sentence a report naming a home wsp cannot build a path under is refused with, on a join and on every
 * link after it. Everything a turn there runs is built from that path, so it is held to the rule every machine's
 * home is held to. */
export const placeHomeRefusal = (said: string | undefined): string =>
  `that computer reported ${said === undefined || said === "" ? "no home folder" : `${JSON.stringify(said)}, which is not a plain path`} for its login, so nothing on it could be reached; wsp holds a machine's home to a plain absolute path`;

/** Every report this host will build a path out of goes through here, and a report reaches this host on three
 * frames: the join, the prove that follows it, and the prove of every relink after that. The rule is the ssh read's
 * own, since what is in a report lands in the commands the host runs on that computer: the home a path is built
 * from is refused when it is not a plain path, the PATH is held to the folders that are ones, and a harness's store
 * folder is kept only where it is one. Answers the report this host will keep, or throws the refusal.
 *
 * The door's two entry points for a report, `join` and `prove`, are its only callers; `attach` takes what `prove`
 * answered, so no road can hand this host a report nothing read. */
export function takenReport(report: PlaceReport): PlaceReport {
  const home = report.login["HOME"];
  if (home === undefined || !isPlainPath(home)) throw new Error(placeHomeRefusal(home));
  const login: Record<string, string> = { ...report.login, HOME: home, PATH: plainPath(report.login["PATH"]) };
  for (const name of SSH_STORE_VARS) {
    const folder = login[name];
    if (folder !== undefined && !isPlainPath(folder)) delete login[name];
  }
  return { ...report, login };
}

/** What stands for each agent a computer reported, in the one word a person reads: its own login on that computer
 * when the file that login shares is under the logins folder the computer listed, else the vault's variable for
 * that agent when this host holds one, else nothing. Nothing at all where the report carries no logins list, which
 * is a daemon older than that field: unknown reads as unknown and not as none.
 *
 * The computer knows no catalog and the host does, so the list of files goes on the wire and the words are worked
 * out here, off the same sign-in rows the sign-in screens and the turns read. */
export function signInsOf(
  report: Pick<PlaceReport, "agents" | "logins">,
  vault: Readonly<Record<string, string>>,
): Record<string, AgentSignInState> | undefined {
  if (report.logins === undefined) return undefined;
  const stands = new Set(report.logins);
  const words: Record<string, AgentSignInState> = {};
  for (const id of report.agents) {
    const file = sharedLoginFile(id);
    if (file !== undefined && stands.has(file)) {
      words[id] = "signed-in";
      continue;
    }
    words[id] = vaultSignIn(id, vault);
  }
  return words;
}

/** The file under a computer's logins folder that an agent's shared login writes, named as the report lists it;
 * nothing for an agent whose login no workspace shares. */
export function sharedLoginFile(agentId: string): string | undefined {
  const shared = sharedOn(agentId);
  return shared === undefined ? undefined : sharedFileIn(shared);
}

/** The word for an agent whose own login is not on the computer: this host's vault holds the token or the key it
 * reads, which every turn there is handed, or nothing stands for it. The one reading every sign-in word falls to. */
export function vaultSignIn(agentId: string, vault: Readonly<Record<string, string>>): AgentSignInState {
  const signIn = CATALOG_AGENTS.find(a => a.id === agentId)?.signIn;
  const token = signIn !== undefined && mintsToken(signIn) ? vault[signIn.tokenEnv] : undefined;
  const keyEnv = signIn === undefined ? undefined : keyEnvOf(signIn);
  return token !== undefined || (keyEnv !== undefined && vault[keyEnv] !== undefined) ? "vault-key" : "none";
}

/** How long between writes of a linked place's last seen. */
export const SEEN_EVERY_MS = 60_000;

/** What a socket is closed with when a newer link for the same place arrives: a laptop that slept and came back is
 * the common case, and the old socket is a connection nothing is on the other end of. */
export const REPLACED = "replaced by a newer link";

export interface Live {
  socket: WebSocket;
  reach: DaemonReach;
  seen: NodeJS.Timeout;
  /** The loopback port carrying to that computer's daemon, opened at the first pane that asks for one. */
  forward?: Promise<PlaceForward>;
}

/** One port on this computer carried to one port on a place: the listener, which stays bound while the link comes
 * and goes, and the connections riding it right now by the id the far side knows each by. */
export interface Forward {
  server: Server;
  localPort: number;
  conns: Map<string, Socket>;
}

/** How long a machine frame waits for its answer when the caller named no bound of its own. A link that dies fails
 * every frame on it at once, so this is the backstop for a place that took the frame and went quiet. No frame does
 * minutes of work: a snapshot is a job the place names at once and is asked after a frame at a time. */
export const LINK_FRAME_MS = 300_000;

/** How long a request the host may ask again waits for the computer to open a socket again. A daemon whose link
 * dropped dials this host back in seconds and its own backoff is bounded well under this, so a gap this long is a
 * computer that went away rather than a socket that blinked, and the stage waiting on it says so and stops. */
export const RELINK_WAIT_MS = 120_000;

/** How long a place gets to say what its backend is, and how long the table asking what room it has left waits;
 * a person is watching both, and a place that does not answer in time shows what this host already knows. */
export const BACKEND_FACTS_MS = 10_000;
/** How long an install waits for that answer before it answers the person: one round trip on a socket the
 * computer has just opened, and no more, since the row it prints is a line at a terminal. */
export const ADD_FACTS_MS = 2_000;
export const CAPACITY_MS = 5_000;
/** How long one dial of a computer gets before it is an answer of its own: a person is watching the button they
 * pressed, and a road that is going to answer answers in well under this. */
export const DIAL_MS = 20_000;

/** How long a computer has to dial back after its own join wrote its place file. A join that landed and a link
 * that never arrives is a network between the two, which is what the sentence says. */
export const JOIN_WAIT_MS = 90_000;

/** Finished adds kept beside the running ones, for a sheet opened after one ended to read what it came to. */
export const ADDS_KEPT = 20;
/** An add names its own stream so its steps can arrive before its answer; a second add under a running one's name
 * would land its steps on the first's job. */
export const ADD_RUNNING_LINE = "an add under that id is still running";
export const ADD_RUNNING_FIX = "Leave the id out, or name the add afresh.";

/** What the box itself said while that wait ran out, where this host holds a login to it and the road to read it:
 * the agent's log names the address it could not dial and why. A read that will not take adds nothing, since the
 * sentence above it is the one the person came for. */
export async function boxSaid(wiring: PlaceWiring, installed: PlaceInstalled): Promise<readonly string[]> {
  if (wiring.log === undefined || installed.ssh === undefined) return [];
  const login = { ssh: installed.ssh, ...(installed.sshKeyPath !== undefined ? { keyPath: installed.sshKeyPath } : {}) };
  return await wiring.log(login).catch(() => []);
}

/** One document per add that has not reached Set up, keyed by its own id. */
export const PENDING = "pending-computers";

/** A pending add as the store keeps it: what a client reads, beside the key file the add named, the host key the
 * person confirmed, the login that reached it and the script that takes its install back, none of which a client is
 * told. The extra fields are written by this door alone and read back as it wrote them. */
export type PendingRecord = PendingComputer & { keyPath?: string; hostKey?: string; undo?: string; login?: string };

/** A pending add as a client reads it. */
export const pendingView = (p: PendingRecord): PendingComputer => {
  const { keyPath: _key, hostKey: _hostKey, undo: _undo, login: _login, ...view } = p;
  return view;
};

/** What the sentence an add that stopped while wsp was going on reads, once its install was taken back. */
export const ADD_STOPPED_LINE = "the host stopped while wsp was being installed there; what the install put there was taken back";
export const ADD_STOPPED_FIX = "Add it again.";
export const ADD_NOT_TAKEN_BACK_LINE = "the host stopped while wsp was being installed there, and what the install put there could not be taken back";

/** One sync of a computer to the recipe it follows: the recipe as this computer has it now, what moved since the
 * computer last applied one, the steps that carry it, and the picks the computer had, which the removals read. */
export interface SyncJob {
  file: RecipeFile;
  items: Record<string, string>;
  hash: string;
  changes: readonly RecipeChange[];
  steps: ReadonlySet<PlaceSetupStep>;
  /** The rows added or changed, by `<kind>/<row>`: the rows a step that would otherwise go over every row is held to. */
  moved: ReadonlySet<string>;
  before: RecipeFile;
  state: PlaceSync;
}

/** How a setup came out, from its waits and its rows: Needs you while a wait stands or a folder or the GitHub sign-in
 * failed, else ready, with how many rows did not install. */
export function setupOutcome(setup: Pick<PlaceSetup, "waiting">, applied: PlaceApplied | undefined): { end: SetupEnd; said?: string } {
  const important = importantFailures(applied);
  const said = [...setup.waiting.map(waitLine), ...important.map(r => `${r.label}: ${r.note ?? "failed"}`)];
  const missed = (applied?.rows ?? []).filter(r => r.outcome === "failed").length;
  return said.length > 0 ? { end: "needs-you", said: said.join("; ") } : { end: "ready", ...(missed > 0 ? { said: `${plural(missed, "row")} did not install` } : {}) };
}

/** The refusal an estimate gets on a runtime whose provisioner weighs nothing. */
export const NO_ESTIMATE_LINE = "this runtime weighs no picks; the host that serves the app wires the reader";

/** How long the read of the end of a setup's log gets on that computer. */
export const LOG_READ_MS = 10_000;

/** How long one row's own removal gets on that computer. */
export const UNDO_MS = 300_000;

/** A sign-in's failure this close to its wait running out reads as the wait running out. */
export const SIGN_IN_SLACK_MS = 5_000;
/** How long gh's own status gets on that computer. */
export const GITHUB_MS = 30_000;
/** The row the GitHub sign-in stands on, and the command its sign-in on that computer runs: gh's own. */
export const GITHUB_ROW = "github";
export const GITHUB_CLI = "gh";

/** The plan with some CLIs first among them, in the order given, each behind the steps it needs so every step still
 * comes after its own: gh, which GitHub and the folders behind it wait on, a CLI whose hook the folders wait on, and
 * the CLIs the servers run, so none of them waits on every CLI. */
export function cliFirst(plan: ProvisionPlan, ids: readonly string[]): ProvisionPlan {
  const clis = plan.steps.slice(plan.agents);
  const first: ToolInstall[] = [];
  for (const id of ids) {
    const chain: ToolInstall[] = [];
    let at = clis.find(s => s.id === id);
    while (at !== undefined && !first.includes(at) && !chain.includes(at)) {
      chain.unshift(at);
      const after = at.after;
      at = clis.find(s => s.id === after);
    }
    first.push(...chain);
  }
  if (first.length === 0) return plan;
  return { ...plan, steps: [...plan.steps.slice(0, plan.agents), ...first, ...clis.filter(s => !first.includes(s))] };
}

/** A setup row the engine read off that computer: the sign-ins, the folders and the GitHub sign-in are the runtime's. */
export const engineRow = (r: PlaceProvisionRow): boolean => r.step !== undefined && r.step !== "signins" && r.step !== "folders" && r.id !== GITHUB_ROW;
/** The lanes no two of the setup's steps share: the package managers, and the folder beside the job a files round
 * stages in. */
export const INSTALLS = "installs";
export const FILES = "files";
/** How long the anonymous read of a folder's repository gets on that computer. */
export const PROBE_MS = 30_000;
/** How long an agent's own status command gets on that computer before a setup decides whether to sign it in. */
export const SIGNIN_STATUS_MS = 30_000;

export const firstLineOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/** The hash of what a computer was set up with, which its applied rows carry. */
export const picksHash = (picks: RecipeFile): string => createHash("sha256").update(recipeCanon({ file: picks, items: {} })).digest("hex");

/** How often the job's lines are appended to the log on the computer, and how many lines go without waiting for
 * that: one exec per line would be one frame per line on a run of hundreds. */
export const PROVISION_LOG_EVERY_MS = 2_000;
export const PROVISION_LOG_LINES = 50;

/** How long a computer that took an update has to come back up running it. The unit restarts the daemon within
 * seconds and its link backs off from two, so a minute is the row reading the new version as the ticket asks
 * rather than a wait a person sits through; a computer slower than that is answered with what it still reads and
 * the reason. */
export const UPDATE_WAIT_MS = 60_000;
/** How often the record is read while that wait runs. */
export const UPDATE_POLL_MS = 500;

/** How long the servers wsp merged into the agents' own files on a computer get to come out before the leave goes
 * on without them: a leave is a decision already made, and one frame of the several this takes may sit out the
 * whole link wait on a computer that is connected and answering nothing. */
export const UNMERGE_MS = 60_000;
