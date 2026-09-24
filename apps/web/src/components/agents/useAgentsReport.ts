// SPDX-License-Identifier: AGPL-3.0-only
// The agents report of one computer or task, read when a page or a panel
// shows it and again on Read again. The last report of each target is kept
// for as long as the window lives, so a computer that stopped answering or a
// task that is paused still draws what stood there when it was last read.
import { useCallback, useEffect, useState } from "react";
import type { AgentsReport, AgentsTarget } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";

const lastReports = new Map<string, AgentsReport>();

/** Forgets every report this window kept, for a test that starts from a first window. */
export const forgetAgentsReports = (): void => lastReports.clear();

interface ReportState {
  readonly key: string | null;
  readonly report: AgentsReport | null;
  readonly reading: boolean;
  /** The one sentence the host refused the read with, while no report stands in its place. */
  readonly error: string | null;
}

const idle = (key: string | null): ReportState => ({ key, report: key === null ? null : (lastReports.get(key) ?? null), reading: false, error: null });

export function useAgentsReport(target: AgentsTarget | null): ReportState & { refresh: () => void } {
  const api = useStore(s => s.api);
  const key = target === null ? null : JSON.stringify(target);
  const [state, setState] = useState<ReportState>(() => idle(key));
  const [asked, setAsked] = useState(0);
  const shown = state.key === key ? state : idle(key);

  useEffect(() => {
    if (key === null || api?.agentsRead === undefined) return;
    let live = true;
    setState(s => ({ ...(s.key === key ? s : idle(key)), reading: true }));
    api.agentsRead(JSON.parse(key) as AgentsTarget).then(
      report => {
        lastReports.set(key, report);
        if (live) setState({ key, report, reading: false, error: null });
      },
      (e: unknown) => {
        if (live) setState(s => ({ ...(s.key === key ? s : idle(key)), reading: false, error: e instanceof Error ? e.message : String(e) }));
      },
    );
    return () => {
      live = false;
    };
  }, [api, key, asked]);

  const refresh = useCallback(() => setAsked(n => n + 1), []);
  return { ...shown, refresh };
}
