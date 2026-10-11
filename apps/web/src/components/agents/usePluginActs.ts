// SPDX-License-Identifier: AGPL-3.0-only
// The plugins road of one target: one plugin turned on or off, keyed by the
// plugin it acts on. The answer is the report read again when the host says
// the agents there changed, so only what runs and why the host refused is kept
// here.
import { useMemo } from "react";
import type { AgentsTarget } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { pluginKey, rowTarget, type PluginActs } from "./agentsRows.js";
import { trackWrite, useTargetHeld, type WriteParts } from "./useTargetHeld.js";

const PARTS: readonly (keyof WriteParts)[] = ["busy", "refused"];

export function usePluginActs(target: AgentsTarget | null): PluginActs | undefined {
  const api = useStore(s => s.api);
  const { targetKey, shown, put } = useTargetHeld<WriteParts>(target, PARTS);
  return useMemo<PluginActs | undefined>(() => {
    if (api === null || api.pluginsToggle === undefined || targetKey === null) return undefined;
    const at = JSON.parse(targetKey) as AgentsTarget;
    return {
      toggle: (row, on) => trackWrite(put, pluginKey(row), api.pluginsToggle!(rowTarget(at, row.project), { agent: row.agent, plugin: row.id }, on), targetKey),
      busyOf: key => shown.busy[key] === true,
      refusedOf: key => shown.refused[key],
    };
  }, [api, put, shown, targetKey]);
}
