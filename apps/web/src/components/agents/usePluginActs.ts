// SPDX-License-Identifier: AGPL-3.0-only
// The plugins road of one target: one plugin turned on or off, keyed by the
// plugin it acts on. The answer is the report read again when the host says
// the agents there changed, so only what runs and why the host refused is kept
// here. A new target starts from nothing, and an answer that lands after the
// target changed is dropped.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsTarget } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { errorText } from "../../lib/utils.js";
import { pluginKey, rowTarget, type PluginActs } from "./agentsRows.js";

interface Held {
  readonly targetKey: string | null;
  readonly busy: Readonly<Record<string, true>>;
  readonly refused: Readonly<Record<string, string>>;
}

const fresh = (targetKey: string | null): Held => ({ targetKey, busy: {}, refused: {} });

export function usePluginActs(target: AgentsTarget | null): PluginActs | undefined {
  const api = useStore(s => s.api);
  const targetKey = target === null ? null : JSON.stringify(target);
  const [held, setHeld] = useState<Held>(() => fresh(targetKey));
  const current = useRef(targetKey);
  useEffect(() => {
    current.current = targetKey;
  }, [targetKey]);
  const shown = held.targetKey === targetKey ? held : fresh(targetKey);

  const put = useCallback(
    (part: "busy" | "refused", key: string, value: string | true | undefined, forKey: string | null): void =>
      setHeld(h => {
        if (current.current !== forKey) return h;
        const base = h.targetKey === forKey ? h : fresh(forKey);
        const next = { ...base[part] } as Record<string, unknown>;
        if (value === undefined) delete next[key];
        else next[key] = value;
        return { ...base, [part]: next };
      }),
    [],
  );

  return useMemo<PluginActs | undefined>(() => {
    if (api === null || api.pluginsToggle === undefined || targetKey === null) return undefined;
    const at = JSON.parse(targetKey) as AgentsTarget;
    return {
      toggle: (row, on) => {
        const key = pluginKey(row);
        put("refused", key, undefined, targetKey);
        put("busy", key, true, targetKey);
        api.pluginsToggle!(rowTarget(at, row.project), { agent: row.agent, plugin: row.id }, on).then(
          () => put("busy", key, undefined, targetKey),
          (e: unknown) => {
            put("busy", key, undefined, targetKey);
            put("refused", key, errorText(e), targetKey);
          },
        );
      },
      busyOf: key => shown.busy[key] === true,
      refusedOf: key => shown.refused[key],
    };
  }, [api, put, shown, targetKey]);
}
