// SPDX-License-Identifier: AGPL-3.0-only
// One agent's plugin on one computer or workspace turned on or off for the
// login, by the agent's own road off its catalog module, pointed at the
// folder its store variable names there. The plugin is found by the same
// module the report reads, so a switch names only a plugin the report shows:
// `claude plugin enable` takes any id and writes it (2.1.296).
import { catalogEntry } from "@wsp/catalog";
import { nodeHost, pluginIo, pluginRow, tilde, type Host } from "@wsp/collect";
import { THIS_COMPUTER, missingPluginRefusal, noPluginSwitchRefusal, noSuchPluginRefusal, pluginMissingLine, projectPluginRefusal } from "@wsp/protocol";
import type { AgentsOn, PluginsActs } from "@wsp/runtime";
import { roadOf } from "./target-road.js";

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

/** The computer an act names in its words. */
const computerOf = (on: AgentsOn): string => (on.kind === "box" ? (on.name ?? "that computer") : on.kind === "here" ? THIS_COMPUTER : "the workspace");

export function pluginsActs(o: { here?: () => Host } = {}): PluginsActs {
  const here = o.here ?? nodeHost;
  return {
    toggle: async (on, ask) => {
      const entry = catalogEntry(ask.agent);
      if (entry?.kind !== "agent") throw usage(`The catalog has no agent ${ask.agent}.`);
      const shelf = entry.pluginShelf;
      if (shelf === undefined) throw usage(noPluginSwitchRefusal(entry.name));
      const road = await roadOf(on, here, "the plugin");
      const io = pluginIo(road.host, entry.id);
      const read = await shelf.read(io, (on.projects ?? []).map(p => ({ id: p.id, name: p.name, path: p.path })));
      const rows = read.plugins.filter(p => p.id === ask.plugin);
      // Only the login's own switch is turned here: a project's lives in its repo.
      const mine = rows.find(p => p.scope === "user");
      if (mine === undefined) {
        const held = rows.find(p => p.setIn !== undefined);
        throw usage(held === undefined ? noSuchPluginRefusal(ask.plugin, entry.name) : projectPluginRefusal(held.id, tilde(road.host.home, held.setIn!)));
      }
      if (mine.missing !== undefined) throw usage(missingPluginRefusal(pluginMissingLine(mine, entry.name, computerOf(on))));
      const turned = await shelf.turn(io, mine, ask.on, read);
      if (turned.refused !== undefined) throw usage(turned.refused);
      return { plugin: pluginRow(road.host, entry.id, { ...mine, on: ask.on }) };
    },
  };
}
