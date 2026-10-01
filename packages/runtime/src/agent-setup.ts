// SPDX-License-Identifier: AGPL-3.0-only
// How each agent runs on each computer the person owns: on or off, the
// program, its config folder, launch arguments and environment, one document
// per computer and agent on the state file, which is the owner's alone. Read
// in memory, since every launch reads it; a variable's value leaves here only
// into a launch's environment, and every reader past that gets the names.
import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { ENV_STRIP_PATTERNS } from "@wsp/adapter-claude";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { agentEnvRefusal, configDirRefusal, noConfigDirLine, setupPatched, shellQuote, type AgentLaunch, type AgentSetup, type AgentSetupSet, type ResolvedFolder } from "@wsp/protocol";
import type { Store } from "./store.js";

export const AGENT_SETUPS = "agentSetups";

/** The variables an agent's own launch drops before it runs, by agent: a setup naming one would set nothing. */
const DROPPED_ENV: Readonly<Record<string, readonly RegExp[]>> = { claude: ENV_STRIP_PATTERNS };

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

const LINK_HOPS = 40;
const loopLine = (path: string): string => `${path} goes round a loop of links`;

/** The path with every link on its way followed, on this computer: the part that exists resolved, a link to a place
 * not made yet read for where it points, the rest kept as named, since a config folder is often made by its agent's
 * first run. */
export async function realFolderHere(path: string): Promise<string> {
  let at = posix.normalize(path);
  let rest = "";
  for (let hops = 0; hops <= LINK_HOPS; ) {
    const real = await realpath(at).catch(() => undefined);
    if (real !== undefined) return rest === "" ? real : join(real, rest);
    const link = await readlink(at).catch(() => undefined);
    if (link !== undefined) {
      at = posix.resolve(dirname(at), link);
      hops += 1;
      continue;
    }
    if (dirname(at) === at) return posix.normalize(path);
    rest = rest === "" ? basename(at) : join(basename(at), rest);
    at = dirname(at);
  }
  throw usage(loopLine(path));
}

/** The same reading on another computer, as one shell line run there: the resolved folder, then that computer's home
 * resolved, one a line. */
export function realFolderScript(path: string): string {
  return [
    `p=${shellQuote(posix.normalize(path))}; rest=; n=0`,
    `while [ ! -e "$p" ] && [ "$p" != / ]; do if [ -L "$p" ]; then n=$((n+1)); if [ "$n" -gt ${LINK_HOPS} ]; then echo ${shellQuote(loopLine(path))} >&2; exit 3; fi; t=$(readlink "$p"); case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac; else rest="/$(basename "$p")$rest"; p=$(dirname "$p"); fi; done`,
    'd=$(cd "$p" 2>/dev/null && pwd -P) || d=$p',
    'printf \'%s%s\\n\' "${d%/}" "$rest"',
    "cd ~ && pwd -P",
  ].join("; ");
}
const keyOf = (placeId: string, agent: string): string => `${placeId}:${agent}`;

/** What a launch of one agent on one computer takes from its setup. */
export interface SetupLaunch {
  configDir?: string;
  /** The variables the launch carries, the config folder's own among them for an agent that reads one. */
  env: Record<string, string>;
  launch?: AgentLaunch;
}

export interface AgentSetups {
  load(): Promise<void>;
  get(placeId: string, agent: string): AgentSetup | undefined;
  /** Whether the person turned the agent off on that computer. */
  off(placeId: string, agent: string): boolean;
  launchOf(placeId: string, agent: string): SetupLaunch;
  /** The change over what stands, checked first; `folder` resolves a config folder on the computer it names,
   * `agentName` is how the agent is named in a refusal. */
  set(placeId: string, agent: string, change: AgentSetupSet, o: { folder: (path: string) => Promise<ResolvedFolder>; agentName: string }): Promise<AgentSetup | undefined>;
}

export function agentSetups(store: Store): AgentSetups {
  const held = new Map<string, AgentSetup>();
  const stateEnvOf = (agent: string): string | undefined => CATALOG_AGENTS.find(a => a.id === agent)?.stateHomeEnv;
  return {
    async load() {
      for (const id of await store.keys(AGENT_SETUPS)) held.set(id, (await store.get(AGENT_SETUPS, id)) as AgentSetup);
    },
    get: (placeId, agent) => held.get(keyOf(placeId, agent)),
    off: (placeId, agent) => held.get(keyOf(placeId, agent))?.on === false,
    launchOf(placeId, agent) {
      const setup = held.get(keyOf(placeId, agent));
      const stateEnv = stateEnvOf(agent);
      const launch = setup?.program !== undefined || setup?.args !== undefined ? { ...(setup.program !== undefined ? { program: setup.program } : {}), ...(setup.args !== undefined ? { args: setup.args } : {}) } : undefined;
      return {
        ...(setup?.configDir !== undefined ? { configDir: setup.configDir } : {}),
        // A variable kept before the rule stood is left off the launch rather than applied.
        env: {
          ...Object.fromEntries(Object.entries(setup?.env ?? {}).filter(([name]) => agentEnvRefusal(name, agent, DROPPED_ENV[agent]) === null)),
          ...(setup?.configDir !== undefined && stateEnv !== undefined ? { [stateEnv]: setup.configDir } : {}),
        },
        ...(launch !== undefined ? { launch } : {}),
      };
    },
    async set(placeId, agent, change, o) {
      const dir = change.configDir;
      if (typeof dir === "string") {
        if (stateEnvOf(agent) === undefined) throw usage(noConfigDirLine(o.agentName));
        if (!dir.startsWith("/")) throw usage(`${o.agentName}'s config folder must be an absolute path, and got ${dir}`);
        const refused = configDirRefusal(o.agentName, dir, await o.folder(dir));
        if (refused !== null) throw usage(refused);
      }
      for (const [name, value] of Object.entries(change.env ?? {})) {
        const refused = value === null ? null : agentEnvRefusal(name, o.agentName, DROPPED_ENV[agent]);
        if (refused !== null) throw usage(refused);
      }
      const next = setupPatched(held.get(keyOf(placeId, agent)), change);
      if (next === undefined) {
        await store.delete(AGENT_SETUPS, keyOf(placeId, agent));
        held.delete(keyOf(placeId, agent));
      } else {
        await store.put(AGENT_SETUPS, keyOf(placeId, agent), next);
        held.set(keyOf(placeId, agent), next);
      }
      return next;
    },
  };
}
