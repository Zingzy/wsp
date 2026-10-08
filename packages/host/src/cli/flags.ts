// SPDX-License-Identifier: AGPL-3.0-only
import type { ParseArgsConfig } from "node:util";
import { type ListenAsked, portsAsked } from "@wsp/protocol";
import { providerEnvWith, type ProviderEnv } from "../providers.js";
import type { HostStarter } from "../host-start.js";
import { wspHome } from "../hosts.js";
import { advertiseWord } from "../pairing.js";
import type { RunningWsp } from "../mcp-install.js";
import { keyLayers } from "./keys.js";
import { statePathFrom } from "./state.js";

/** Everything a person asked a host to serve with: the port pair and the address the one rule read off the flags,
 * the state file, and the words that only a serving host reads. `wsp up --service` writes its unit out of this, so
 * what the service starts is the line that was typed. */
export interface ServeAsked extends ListenAsked {
  statePath: string;
  /** The address the person named with --advertise, as they named it: the address a computer being joined dials
   * this host at. Absent leaves the join to what this computer answers on, which is the default, so only a word the
   * person typed is spelled back into a service's unit. */
  advertise?: string;
  /** The machine provider this host forks on, as `--provider` named it. */
  provider?: string;
  /** Whether a box linked to a relay runs its connector; false is `--no-relay`. */
  relay?: boolean;
}

/** A flag of the line a host serves on: how the shared parse reads it, and the words it is spelled back as. The
 * parse and the service's unit both come out of this one table, so a flag that shapes a serving host cannot reach a
 * terminal run and be dropped by the service that was asked for the same line. */
interface ServeFlag {
  /** The flag's word, which is a key of the shared parse: a row cannot name one the parse would not read. */
  name: Extract<keyof SharedFlags, string>;
  option: Options[string];
  words(asked: ServeAsked): string[];
  /** Only means something on a cloud: with none registered it prints in no help, and typing it is refused by the flag. */
  cloud?: true;
}

export const SERVE_FLAGS: readonly ServeFlag[] = [
  { name: "state", option: { type: "string" }, words: a => ["--state", a.statePath] },
  { name: "port", option: { type: "string" }, words: a => ["--port", String(a.port)] },
  { name: "listen", option: { type: "string" }, words: a => ["--listen", a.address] },
  { name: "advertise", option: { type: "string" }, words: a => (a.advertise === undefined ? [] : ["--advertise", a.advertise]) },
  { name: "provider", option: { type: "string" }, cloud: true, words: a => (a.provider === undefined ? [] : ["--provider", a.provider]) },
  { name: "no-relay", option: { type: "boolean" }, words: a => (a.relay === false ? ["--no-relay"] : []) },
];

/** The serving flags as the parser takes them. */
const SERVE_OPTIONS: Options = Object.fromEntries(SERVE_FLAGS.map(flag => [flag.name, flag.option]));

/** What every command of the shared parse works on: what was asked of a serving host, the home the hosts file sits
 * under, and the environment the run was made in. wsp up and wsp init take theirs from this one call. */
export interface SharedOpts extends ServeAsked {
  home: string;
  /** The environment this run picks its machine provider out of: the one the caller runs in, with the provider
   * words the command line was given in front of it. */
  providerEnv: ProviderEnv;
  /** The environment the caller runs in, as given: what reads WSP_HOST and the pair a turn's launch left, so a
   * command decides where a line is aimed from the run's own environment rather than this process's. */
  env: Readonly<Record<string, string | undefined>>;
  /** What brings a host up when none serves this state file, as the verbs are handed one. Set by the run, not by
   * the flags, and read only by the words whose work is the host's; absent leaves a line to read the refusal. */
  start?: HostStarter;
  /** How this process was started, set by the run: what the host wsp up serves writes into an agent's config and
   * runs its turns' wsp as, and what the unit wsp up --service writes runs. */
  running?: RunningWsp;
}

/** The environment the caller runs in decides the home, the same reading the verbs take, so a run with its own
 * environment cannot send wsp hosts to one folder and --host to another. It is also what the provider words
 * stand in front of, so one run picks its folder and its provider out of the same environment. */
export function optsFor(
  values: Pick<SharedFlags, "port" | "listen" | "advertise" | "state" | "provider" | "no-relay">,
  env: Readonly<Record<string, string | undefined>> = process.env,
  note: (line: string) => void = () => {},
): SharedOpts {
  const asked = portsAsked({ port: values.port, listen: values.listen });
  const advertise = advertiseWord(values.advertise);
  const provider = values.provider !== undefined ? { provider: values.provider } : {};
  // The state file first: every verb's environment is built off the .env beside it, so a run under --state carries
  // no key and no pick of the live home's.
  const statePath = statePathFrom(values.state, env, note);
  return {
    ...asked,
    ...(advertise !== undefined ? { advertise } : {}),
    ...provider,
    ...(values["no-relay"] === true ? { relay: false } : {}),
    statePath,
    home: wspHome(env),
    env,
    providerEnv: providerEnvWith(provider, env, keyLayers({ env, cwd: process.cwd(), statePath })),
  };
}

/** The flags the shared parse reads; a command that answers on its own word (mcp, recipe) parses its own. */
export interface SharedFlags {
  version?: boolean;
  help?: boolean;
  port?: string;
  listen?: string;
  advertise?: string;
  state?: string;
  yes?: boolean;
  force?: boolean;
  "non-interactive"?: boolean;
  json?: boolean;
  recipe?: string;
  project?: string;
  "first-workspace"?: string;
  import?: string;
  on?: string;
  into?: string;
  rebuild?: boolean;
  "no-local"?: boolean;
  local?: boolean;
  service?: boolean;
  code?: string;
  "code-file"?: string;
  "ssh-port"?: string;
  "ssh-key"?: string;
  "host-key"?: string;
  base?: string;
  keep?: string[];
  cut?: string[];
  "no-memory"?: boolean;
  "no-commits"?: boolean;
  remember?: boolean;
  later?: boolean;
  resume?: boolean;
  watch?: boolean;
  update?: boolean;
  "sign-in"?: string;
  name?: string;
  host?: string;
  "no-relay"?: boolean;
  provider?: string;
}

export type Options = NonNullable<ParseArgsConfig["options"]>;

/** The flags the shared parse reads for up, init and doctor. The ones that shape a serving host come from the table
 * the service's unit is written out of, so neither road can read a flag the other has never heard of. */
export const SHARED_OPTIONS: Options = {
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  ...SERVE_OPTIONS,
  yes: { type: "boolean", short: "y" },
  force: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  json: { type: "boolean" },
  recipe: { type: "string" },
  project: { type: "string" },
  "first-workspace": { type: "string" },
  import: { type: "string" },
  on: { type: "string" },
  into: { type: "string" },
  rebuild: { type: "boolean" },
  "no-local": { type: "boolean" },
  local: { type: "boolean" },
  service: { type: "boolean" },
  code: { type: "string" },
  "code-file": { type: "string" },
  "ssh-port": { type: "string" },
  "ssh-key": { type: "string" },
  "host-key": { type: "string" },
  base: { type: "string" },
  keep: { type: "string", multiple: true },
  cut: { type: "string", multiple: true },
  "no-memory": { type: "boolean" },
  "no-commits": { type: "boolean" },
  remember: { type: "boolean" },
  watch: { type: "boolean" },
  update: { type: "boolean" },
  later: { type: "boolean" },
  resume: { type: "boolean" },
  "sign-in": { type: "string" },
  name: { type: "string" },
  host: { type: "string" },
};
