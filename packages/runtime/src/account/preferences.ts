// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { type Preferences, type PreferencesPatch, type Caller, THIS_COMPUTER, threadKeyOf, isLocalWorkspace, applyPreferencesPatch, serverIconsLeftLine, homeShortened, labsFromEnv, noAdapterLine, preferencesFrom, bareNoSuchProjectLine, absentComputer, HERE_PLACE_ID, accessRefusal, modelIdRefusal, setupView, type AccessChoice } from "@wsp/protocol";
import { agentsReads, type ServerIcons } from "../agents-read.js";
import { keyOf } from "../agent-setup.js";
import { harnessCatalog } from "../harness-catalog.js";
import type { Runtime } from "../types/api.js";
import { PREFERENCES, PREFERENCES_ID } from "../types/internal.js";
import type { RuntimeContext, PreferencesArea } from "../context.js";

export function preferencesArea(ctx: RuntimeContext): PreferencesArea {
  const { opts, backend, store, adapters, placeDoor, bus, clock, projectsHeld, setups } = ctx;
  // Sets run one after another: two clients patching different fields at once would otherwise each read the record
  // before the other's write and the later write would drop the earlier field.
  let preferenceWrites: Promise<unknown> = Promise.resolve();
  // Read once, here, and stamped on every read: a state file that holds an older labs cannot outvote the environment.
  const labs = labsFromEnv(opts.env ?? process.env);
  /** The record is kept whether or not the folder goes; a folder that stays is said on the reply. */
  const iconsForgotten = (): string | undefined => {
    const icons = opts.serverIcons;
    if (icons === undefined) return undefined;
    try {
      icons.forget();
      return undefined;
    } catch (e) {
      // Node's own words carry the code before and the call and path after: "EACCES: permission denied, rmdir '/x'".
      const said = e instanceof Error ? e.message.replace(/^[A-Z]+: /, "").replace(/, \w+ '[^']*'$/, "") : String(e);
      return serverIconsLeftLine(homeShortened(icons.folder, homedir()), said);
    }
  };
  /** Why a change to the defaults cannot stand: an agent this host runs no thread of, a project it does not hold, or
   * an access word the agent it lands on maps to none of its modes, which is refused here rather than run looser. */
  const defaultsRefusal = (patch: PreferencesPatch, next: Preferences): void => {
    const usage = (line: string): Error => Object.assign(new Error(line), { kind: "usage" });
    const agent = (id: string): void => {
      if (adapters[id] === undefined) throw usage(noAdapterLine(id, Object.keys(adapters)));
    };
    const word = (id: string, access: AccessChoice | null | undefined): void => {
      const table = harnessCatalog(id);
      const said = access == null ? null : accessRefusal(table ?? { label: ctx.agentLabel(id), permissionModes: [] }, access);
      if (said !== null) throw usage(said);
    };
    const model = (id: string): void => {
      const said = modelIdRefusal(id);
      if (said !== null) throw usage(said);
    };
    if (patch.defaultAgent != null) agent(patch.defaultAgent);
    for (const [id, set] of Object.entries(patch.agentDefaults ?? {})) {
      if (set === null) continue;
      agent(id);
      word(id, set.access);
      for (const named of [...(set.model == null ? [] : [set.model]), ...(set.models?.custom ?? [])]) model(named);
    }
    for (const [projectId, set] of Object.entries(patch.projectDefaults ?? {})) {
      if (set === null) continue;
      if (!projectsHeld.has(projectId)) throw usage(bareNoSuchProjectLine(projectId));
      if (set.agent != null) agent(set.agent);
      if (set.model != null) model(set.model);
      const kept = next.projectDefaults[projectId];
      word(kept?.agent ?? ctx.defaultAgentOf(next, undefined), set.access);
    }
  };
  /** The shut entries of leads the host still holds: a lead stands while its rows or its thread record do. A thread
   * kept from before thread records has rows alone, and one whose rows fell off the index cap has its record alone. */
  const heldLeads = (shut: Record<string, true>): Record<string, true> => {
    const rows = new Set([...ctx.sessions.values()].map(row => threadKeyOf(row.view)));
    return Object.fromEntries(Object.entries(shut).filter(([lead]) => rows.has(lead) || ctx.threadRecords.has(lead)));
  };
  const preferences: Runtime["preferences"] = {
    get: async () => (ctx.state.preferencesHeld ??= { ...preferencesFrom(await store.get(PREFERENCES, PREFERENCES_ID)), labs }),
    set: patch => {
      const write = preferenceWrites.then(async () => {
        await ctx.ready();
        const merged = applyPreferencesPatch(await preferences.get(), patch);
        const next = patch.threadsShut === undefined || merged.threadsShut === undefined ? merged : { ...merged, threadsShut: heldLeads(merged.threadsShut) };
        defaultsRefusal(patch, next);
        await store.put(PREFERENCES, PREFERENCES_ID, next);
        ctx.state.preferencesHeld = next;
        const notice = patch.serverIcons === false ? iconsForgotten() : undefined;
        bus.emit({ type: "preferences.changed", preferences: next });
        return notice === undefined ? { preferences: next } : { preferences: next, notice };
      });
      preferenceWrites = write.catch(() => undefined);
      return write;
    },
  };

  const iconsOn = async (): Promise<boolean> => (await preferences.get()).serverIcons;
  const agentsRead = agentsReads<Caller>({
    reader: opts.agentsReader,
    places: () => placeDoor,
    workspace: async (id, origin) => {
      const entry = await ctx.entryOf(id, origin);
      const project = ctx.projectHeld(entry.record.project);
      const local = isLocalWorkspace(entry.record);
      const stores = Object.fromEntries(
        CATALOG_AGENTS.flatMap(a => {
          const folder = local || a.stateHomeEnv === undefined ? undefined : ctx.threadEnv(entry, a.id)[a.stateHomeEnv];
          return folder === undefined ? [] : [[a.id, folder]];
        }),
      );
      return { name: entry.record.name, phase: entry.record.phase, local, machine: entry.machine, project: { id: project.id, name: project.name, path: ctx.checkoutOf(entry.record) }, stores };
    },
    placeStores: ctx.placeStores,
    // A project's folder on the computer holding it: the checkout the add left there, else where it already sits.
    projects: async placeId => (await ctx.ready(), [...projectsHeld.values()].filter(p => p.computer === placeId).map(p => ({ id: p.id, name: p.name, path: p.checkout ?? p.path }))),
    ...(opts.agentsActs !== undefined ? { acts: opts.agentsActs } : {}),
    ...(opts.skillsActs !== undefined ? { skills: opts.skillsActs } : {}),
    ...(opts.serversActs !== undefined ? { servers: opts.serversActs } : {}),
    latestOn: async () => (await preferences.get()).agentVersions,
    // The person's switch is read at every ask, so turning it off stops the next one.
    ...(opts.serverIcons !== undefined ? { icons: { folder: opts.serverIcons.folder, icon: async (host, refresh) => ((await iconsOn()) ? opts.serverIcons!.icon(host, refresh, iconsOn) : null), forget: () => opts.serverIcons!.forget() } satisfies ServerIcons } : {}),
    // The target's own daemon: this computer's, a joined computer's over the link it holds, or a workspace's by the
    // road its kind answers, which is the one reading every pane takes.
    channel: async (target, onEvent, origin) => {
      if ("workspaceId" in target) return ctx.workspaces.daemonChannel(target.workspaceId, onEvent, origin);
      if (target.placeId === HERE_PLACE_ID) return ctx.channelOver(await ctx.localRoad(), THIS_COMPUTER, onEvent);
      const onLink = placeDoor?.channel(target.placeId, onEvent);
      if (onLink === undefined) throw new Error(absentComputer(placeDoor?.nameOf(target.placeId) ?? target.placeId, null).sentence);
      return onLink;
    },
    changed: target => bus.emit({ type: "agents.changed", ...(target !== undefined ? { target } : {}) }),
    setupOf: (placeId, agent) => (adapters[agent] === undefined ? undefined : setupView(setups.get(placeId, agent))),
    setupWrite: async (placeId, agent, change) => {
      if (adapters[agent] === undefined) throw Object.assign(new Error(noAdapterLine(agent, Object.keys(adapters))), { kind: "usage" });
      await setups.set(placeId, agent, change, { folder: path => ctx.configFolderOn(placeId, path), agentName: ctx.agentLabel(agent) });
      ctx.setupRefusals.delete(keyOf(placeId, agent));
    },
    relayed: () => backend.capabilities.callbackRelay,
    now: () => clock.now(),
  });
  bus.on("workspace.deleted", e => {
    if (e.type === "workspace.deleted") agentsRead.forget(e.workspaceId);
  });
  return { preferences, agentsRead };
}
