// SPDX-License-Identifier: AGPL-3.0-only
// The servers road of one target: a server added from the form, which keeps
// its own values and hears the host's answer, and one entry's rows removed or
// turned off or on, one ask per agent it is set up for, keyed by the entry. A
// write's answer is the report read again when the host says the agents there
// changed, so only what runs and why the host refused is kept here; a new
// target starts from nothing, and an answer for an old one is dropped.
import { useMemo } from "react";
import type { AgentsTarget, McpRow, ServerAsk } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { rowTarget, type ServerActs } from "./agentsRows.js";
import { trackWrite, useTargetHeld, type WriteParts } from "./useTargetHeld.js";

const PARTS: readonly (keyof WriteParts)[] = ["busy", "refused"];

const askOf = (row: McpRow): ServerAsk => ({ agent: row.agent, name: row.name, scope: row.scope });

export function useServerActs(target: AgentsTarget | null): ServerActs | undefined {
  const api = useStore(s => s.api);
  const { targetKey, shown, put } = useTargetHeld<WriteParts>(target, PARTS);

  return useMemo<ServerActs | undefined>(() => {
    if (api === null || api.serversAdd === undefined || targetKey === null) return undefined;
    const at = JSON.parse(targetKey) as AgentsTarget;
    /** One entry's asks, one agent after another: busy while they run, the first refusal kept until the next try. */
    const write = (key: string, rows: readonly McpRow[], ask: (row: McpRow) => Promise<unknown> | undefined): void =>
      trackWrite(
        put,
        key,
        (async () => {
          for (const row of rows) await ask(row);
        })(),
        targetKey,
      );
    return {
      add: (ask, project) => api.serversAdd!(rowTarget(at, project), ask),
      remove: (key, rows) => write(key, rows, row => api.serversRemove?.(rowTarget(at, row.project), askOf(row))),
      toggle: (key, rows, on) => write(key, rows, row => api.serversToggle?.(rowTarget(at, row.project), askOf(row), on)),
      busyOf: key => shown.busy[key] === true,
      refusedOf: key => shown.refused[key],
    };
  }, [api, put, shown, targetKey]);
}
