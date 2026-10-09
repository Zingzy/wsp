// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { jsonFileStore, sqliteStore, stateDbPath, type Store } from "@wsp/runtime";
import { HOME_ENV, STATE_STORE_ENV } from "@wsp/protocol";
import { savedEnv } from "../env-keys.js";
import { servingHost } from "../host-lock.js";
import { homeNamed, realState, servingHome } from "../serving-home.js";
import { stateWriterHere } from "../version.js";

/** The name this repository's own root package.json carries. The marker has to be something only a checkout has:
 * a `.env` is not, since wsp writes the person's provider keys into their own wsp home, and that home then read as
 * a checkout whose state nothing had ever written. */
const CHECKOUT_PACKAGE = "wsp";

/** Whether this folder is a checkout of wsp: its own root package.json names the workspace. A worktree of the
 * repository carries the same file and is one too. */
function isDevCheckout(cwd: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return (parsed as { name?: unknown } | null)?.name === CHECKOUT_PACKAGE;
  } catch {
    return false;
  }
}

/** The state a checkout of wsp marks: its own `.wsp` state. One spelling of the rule, since the bin
 * and the desktop both apply it. */
export function devCheckoutState(cwd: string): string | undefined {
  return isDevCheckout(cwd) ? join(cwd, ".wsp", "state.json") : undefined;
}

/** Which state a line runs against, and what a person should be told about the choice. */
export interface StatePick {
  path: string;
  /** The one line stderr gets when a state the person named passed over a .env beside the code. */
  note?: string;
}

const passedOverLine = (chosen: string, by: string, cwd: string, dev: string): string =>
  `this runs against ${chosen}, named by ${by}; the checkout in ${cwd} marks ${dev}, which this run does not use.`;

/** The state file a run works on. A state the person chose wins: --state first, then WSP_HOME, since a state
 * somebody named is never taken off them by a file they did not name, and the choice is said out loud when a
 * checkout named another. A checkout marks its own state only when nothing else names one, and anywhere
 * else it is the home whose host is serving, so a line typed with no flags on a computer whose host runs under a
 * moved home reaches that host rather than a state file nothing serves. */
export function statePick(flag?: string, cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): StatePick {
  const dev = devCheckoutState(cwd);
  const home = homeNamed(env[HOME_ENV]);
  const named = flag !== undefined ? { path: flag, by: "--state" } : home !== undefined ? { path: join(home, "state.json"), by: HOME_ENV } : undefined;
  if (named === undefined) return { path: dev ?? join(servingHome(env), "state.json") };
  if (dev === undefined || realState(resolve(cwd, dev)) === realState(resolve(cwd, named.path))) return { path: named.path };
  return { path: named.path, note: passedOverLine(resolve(cwd, named.path), named.by, cwd, dev) };
}

/** The state file a run that names none works on. */
export function defaultStatePath(cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  return statePick(undefined, cwd, env).path;
}

/** The state file a command works on, absolute so the lock, the token and the recipe beside it name one path
 * whatever the cwd is; a caller with somewhere to say it hears which state won where two readings disagreed. */
export function statePathFrom(flag?: string, env: Readonly<Record<string, string | undefined>> = process.env, note: (line: string) => void = () => {}): string {
  const pick = statePick(flag, process.cwd(), env);
  if (pick.note !== undefined) note(pick.note);
  return resolve(pick.path);
}

/** The state files a host on this computer could be serving: the one this run works on and this computer's default,
 * read so a port one of them holds is named as that host rather than as a bare node process. */
export function statesHere(statePath: string): string[] {
  return [...new Set([statePath, resolve(defaultStatePath())])];
}

/** The store a state is kept in: the SQLite database beside the state file, or the JSON document where
 * STATE_STORE_ENV says json in this environment or the .env beside it. A state file not imported yet that a live
 * host serves stays the JSON document for this process too: that host goes on writing the file, and an import
 * under it would leave every write it makes after out of the database. */
export function stateStore(statePath: string, env: Readonly<Record<string, string | undefined>> = process.env): Store {
  const json =
    env[STATE_STORE_ENV] === "json" ||
    savedEnv(statePath)[STATE_STORE_ENV] === "json" ||
    (!existsSync(stateDbPath(statePath)) && existsSync(statePath) && servingHost(statePath) !== undefined);
  return json ? jsonFileStore(statePath, stateWriterHere()) : sqliteStore(statePath, stateWriterHere());
}
