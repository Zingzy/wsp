// SPDX-License-Identifier: AGPL-3.0-only
// Each server's tools as its last ask on this target stands: asked only when
// the person presses List tools or Read again, since asking starts the server
// once on that computer. A new target starts from nothing, and an answer that
// lands after the target changed is dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentsTarget, McpRow, ServerToolsAnswer } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import type { ServerTools, ToolsState } from "./agentsRows.js";

const keyOf = (row: Pick<McpRow, "agent" | "scope" | "name">): string => `${row.agent}\0${row.scope}\0${row.name}`;

export function useServerTools(target: AgentsTarget | null): ServerTools | undefined {
  const api = useStore(s => s.api);
  const targetKey = target === null ? null : JSON.stringify(target);
  const [states, setStates] = useState<{ targetKey: string | null; of: Record<string, ToolsState> }>({ targetKey, of: {} });
  const current = useRef(targetKey);
  useEffect(() => {
    current.current = targetKey;
  }, [targetKey]);
  const shown = states.targetKey === targetKey ? states.of : {};
  const ask = api?.serversTools;

  const list = useCallback(
    (row: McpRow, refresh = false): void => {
      if (targetKey === null || ask === undefined) return;
      const key = keyOf(row);
      const put = (next: (was: ToolsState | undefined) => ToolsState): void =>
        setStates(s => {
          if (current.current !== targetKey) return s;
          const of = s.targetKey === targetKey ? s.of : {};
          return { targetKey, of: { ...of, [key]: next(of[key]) } };
        });
      put(was => ({ ...(was?.answer === undefined ? {} : { answer: was.answer }), listing: true }));
      ask(JSON.parse(targetKey) as AgentsTarget, row.agent, row.name, refresh).then(
        (answer: ServerToolsAnswer) => put(() => ({ listing: false, answer })),
        (e: unknown) => put(was => ({ ...(was?.answer === undefined ? {} : { answer: was.answer }), listing: false, error: e instanceof Error ? e.message : String(e) })),
      );
    },
    [ask, targetKey],
  );

  if (ask === undefined || targetKey === null) return undefined;
  return { of: row => shown[keyOf(row)], list };
}
