// SPDX-License-Identifier: AGPL-3.0-only
// How each agent runs on each computer the person owns: on or off, the
// program, its config folder, launch arguments and environment, one document
// per computer and agent on the state file, which is the owner's alone. Read
// in memory, since every launch reads it; a variable's value leaves here only
// into a launch's environment, and every reader past that gets the names.
import { ENV_STRIP_PATTERNS } from "@wsp/adapter-claude";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { configDirIsHomeLine, droppedEnvLine, noConfigDirLine, setupPatched, type AgentLaunch, type AgentSetup, type AgentSetupSet } from "@wsp/protocol";
import type { Store } from "./store.js";

export const AGENT_SETUPS = "agentSetups";

/** The variables an agent's own launch drops before it runs, by agent: a setup naming one would set nothing. */
const DROPPED_ENV: Readonly<Record<string, readonly RegExp[]>> = { claude: ENV_STRIP_PATTERNS };

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });
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
  /** The change over what stands, checked first; `home` is that computer's home folder, `agentName` how the agent is
   * named in a refusal. */
  set(placeId: string, agent: string, change: AgentSetupSet, o: { home: string | undefined; agentName: string }): Promise<AgentSetup | undefined>;
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
        env: { ...setup?.env, ...(setup?.configDir !== undefined && stateEnv !== undefined ? { [stateEnv]: setup.configDir } : {}) },
        ...(launch !== undefined ? { launch } : {}),
      };
    },
    async set(placeId, agent, change, o) {
      const dir = change.configDir;
      if (typeof dir === "string") {
        if (stateEnvOf(agent) === undefined) throw usage(noConfigDirLine(o.agentName));
        if (!dir.startsWith("/")) throw usage(`${o.agentName}'s config folder must be an absolute path, and got ${dir}`);
        if (o.home !== undefined && dir.replace(/\/+$/, "") === o.home.replace(/\/+$/, "")) throw usage(configDirIsHomeLine(o.agentName));
      }
      for (const name of Object.keys(change.env ?? {})) {
        if ((DROPPED_ENV[agent] ?? []).some(p => p.test(name)) && change.env?.[name] !== null) throw usage(droppedEnvLine(o.agentName, name));
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
