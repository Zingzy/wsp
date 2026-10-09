// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from "node:path";
import { serverValuesOf } from "@wsp/catalog";
import { authRefusal, THIS_COMPUTER } from "@wsp/protocol";
import { checkProviderKey, keyCheckLine, type KeyCheck } from "@wsp/engine";
import { providerBackendFor, providerEnvWith, providerEnvWithKey, providerKeyRow, type ProviderEnv } from "../providers.js";
import { ANTHROPIC_KEY, KEY_LAYER_WORDS, envFileFor, keyIn, parseEnvFile, savedEnv, serverEnvFileFor, vaultOf, writeEnvFile, type Keys } from "../env-keys.js";
import { DEFAULT_HOME } from "../hosts.js";
import type { CliIO } from "./io.js";

export interface KeySources {
  env: Record<string, string | undefined>;
  cwd: string;
  /** The state file this run serves. The third layer is the .env beside it, so a host on another state file reads
   * no key of the wsp home's and makes no request with one it was never given. */
  statePath: string;
  /** Whether the provider takes a key, the one check the app's keys step also runs. Absent means this computer can
   * answer nothing about a key, so nothing is checked and nothing is refused for it; `keySources` always carries it,
   * and a test hands over its own answer through the same field. */
  checkKey?(key: string): Promise<KeyCheck>;
}

/** Where a key is read from, in the order they win: this process's environment, then ./.env, then the .env beside
 * the state file this run serves. The first two are the shell's and the checkout's, named by whoever typed the
 * line; the third is the host's own, which moves with --state as everything else a host writes for itself does. */
export function keyLayers(sources: KeySources): Array<Record<string, string | undefined>> {
  return [sources.env, parseEnvFile(join(sources.cwd, ".env")), parseEnvFile(envFileFor(sources.statePath))];
}

/** Where a key is read from on this computer: the environment the run picks its provider out of, the folder it runs
 * in, and the state file it serves. One answer, so a test can hand a different one through the same field rather
 * than move the process. */
export function keySources(env: ProviderEnv, statePath: string): KeySources {
  // The key is put to the provider this run is wired to, under that row's own variable: a person who named a
  // provider is typing that provider's key, whatever another row would have been taken by.
  return { env, cwd: process.cwd(), statePath, checkKey: key => checkProviderKey(providerBackendFor(providerEnvWithKey(env, key))) };
}

/** The environment a run picks its provider out of, as this computer stands now: the run's own with the command
 * line's words already in it, and every registered row's key variable taken from the three layers. */
export function providerEnvNow(env: ProviderEnv, statePath: string, cwd: string = process.cwd()): ProviderEnv {
  return providerEnvWith({}, env, keyLayers({ env, cwd, statePath }));
}

/** How many keys one run takes before it stops asking: a mistyped key is worth another go, an endless prompt is not. */
const KEY_TRIES = 3;

/** What no provider key means for the command that asked. `refuse` is the road every command that needs a machine
 * takes: nothing it does has any meaning without one. `offer` is wsp init's: at a terminal the key is asked for with
 * the way to skip it, and an empty answer takes the local road, since this computer is a workspace of its own. `local`
 * is the road of up, up --service and doctor --local: init already answered, so nothing is asked and
 * the run goes on with no provider. */
export type NoProviderKey = "refuse" | "offer" | "local";

/** What a run reads its keys as: the agents' keys, and the environment its provider is picked out of, carrying
 * every registered row's key variable as the layers hold it and whatever this run was told to type. */
export interface LoadedKeys {
  keys: Keys;
  env: ProviderEnv;
}

export async function loadKeys(
  io: CliIO,
  sources: KeySources,
  ask: { anthropic: boolean; noProviderKey?: NoProviderKey; checkSaved?: boolean } = { anthropic: true },
): Promise<LoadedKeys> {
  const ownEnv = envFileFor(sources.statePath);
  const layers = keyLayers(sources);
  const env = providerEnvWith({}, sources.env, layers);
  // The row this run is wired to, which is the only one it is asked about: the variable it reads its key from is
  // the one named on the screen, written to the file and put to the provider.
  const row = providerKeyRow(env);
  const keyEnv = row?.keyEnv;
  const held = keyEnv === undefined ? undefined : keyIn(env, keyEnv);
  let anthropic = keysFound(sources, layers).anthropic;
  const loaded = (key: string | undefined): LoadedKeys => ({
    keys: anthropic !== undefined ? { anthropic } : {},
    env: keyEnv === undefined ? env : { ...env, [keyEnv]: key },
  });
  /** The provider's refusal of a key, in the words the app's keys step uses, or nothing. Only a refusal counts: a
   * check nothing answered says nothing about the key, so it is taken and the build says its own piece if it must. */
  const refusalOf = async (key: string, saved: boolean): Promise<string | undefined> => {
    if (sources.checkKey === undefined || row === undefined) return undefined;
    const check = await sources.checkKey(key);
    return check.state === "refused" ? keyCheckLine(check, row.id, saved) : undefined;
  };
  // The key a run is about to build with is put to the provider here, so a key it refuses is typed again on this run
  // rather than stopping the build on the far side of the confirm. Every other verb takes a saved key as it stands:
  // one of them on a computer with no road out would otherwise refuse to do work that needs no provider at all.
  let refusedSaved: string | undefined;
  if (held !== undefined) {
    refusedSaved = ask.checkSaved === true ? await refusalOf(held, true) : undefined;
    if (refusedSaved === undefined) return loaded(held);
  }
  // No key on this computer and either a road init already answered, nobody at a keyboard to type one, or a
  // provider that reads no key at all: the local road is taken without a question. Every other command still
  // refuses through its IO's own words below. The Claude key rides on either way: it is the agents' key, not the
  // provider's, and a local thread uses it as a fork would.
  // A refused key is never quietly dropped for the local road: nobody asked for this computer, the provider did.
  if (refusedSaved !== undefined && io.isTTY !== true) throw authRefusal(refusedSaved);
  if (keyEnv === undefined || ask.noProviderKey === "local" || (ask.noProviderKey === "offer" && io.isTTY !== true)) return loaded(undefined);

  // Not wrapped: the CLI's IOs already refuse a secret as the contract's auth class, so a caller with no terminal
  // to type one on exits on that code rather than on a generic failure.
  const where = row?.keyConsole !== undefined ? `\n${row.keyConsole}` : "";
  const skip = ask.noProviderKey === "offer" ? `\nEnter with nothing skips the cloud: ${THIS_COMPUTER} alone becomes your workspace, and nothing is sealed.` : "";
  // The variable is said once, on the line that says where a key goes so this screen is not drawn again.
  let why = refusedSaved ?? `No ${keyEnv} in ${KEY_LAYER_WORDS}.`;
  let key: string;
  for (let attempt = 1; ; attempt++) {
    const typed = (await io.askSecret(`${row?.keyName ?? keyEnv}\n${why}${where}${skip}`, keyEnv)).trim();
    if (!typed) {
      if (ask.noProviderKey === "offer") return loaded(undefined);
      throw authRefusal(`${keyEnv} is needed to start.`);
    }
    // Checked before it is written, so a key the provider refuses never reaches the file the whole setup reads.
    const refused = await refusalOf(typed, false);
    if (refused === undefined) {
      key = typed;
      break;
    }
    if (attempt >= KEY_TRIES) throw authRefusal(refused);
    why = refused;
  }
  const set: Record<string, string> = { [keyEnv]: key };

  if (anthropic === undefined && ask.anthropic) {
    const typed = (
      await io.askSecret("Anthropic API key\noptional, enter skips\nOn a Claude subscription, skip this and sign in with /login on the machine instead.", ANTHROPIC_KEY)
    ).trim();
    if (typed) {
      anthropic = typed;
      set[ANTHROPIC_KEY] = typed;
    }
  }

  if ((await io.ask(saveQuestion(dirname(sources.statePath), Object.keys(set).length))) === "yes") writeEnvFile(ownEnv, set);
  return loaded(key);
}

/** The agents' keys as the environment and the files hold them now, asking nothing: what a serving host reads when
 * the init job asks, and where loadKeys starts before it asks. */
export function keysFound(sources: KeySources, layers: Array<Record<string, string | undefined>> = keyLayers(sources)): Keys {
  const anthropic = layers.map(l => keyIn(l, ANTHROPIC_KEY)).find(v => v !== undefined);
  return anthropic !== undefined ? { anthropic } : {};
}

/** What the vault hands every turn, read at each launch off the .env beside the state file this host serves and
 * nothing else. Not this shell: a host serving under launchd, and the app, start without it, so a key only in a
 * shell would reach the turns one road launched and none of the others. Not a folder's .env either: the folder a
 * host happened to start in is nobody's vault. The one file is what wsp init writes and what the person can read,
 * and a token saved there while the host runs is in the next turn, since nothing of this is cached. The servers'
 * values beside it come too, under the names their definitions on other computers read, and a server's own value
 * outranks the GitHub token a box's setup saved under the same name. */
export function vaultNow(statePath: string): Record<string, string> {
  return { ...vaultOf(savedEnv(statePath)), ...serverValuesOf(parseEnvFile(serverEnvFileFor(statePath))) };
}

/** Names the file only when the state file this run serves is not the default home's. */
export function saveQuestion(folder: string, keys: number): string {
  const what = keys > 1 ? "keys" : "key";
  return folder === DEFAULT_HOME ? `Save the ${what} so wsp stops asking?` : `Save the ${what} to ${join(folder, ".env")} so wsp stops asking?`;
}
