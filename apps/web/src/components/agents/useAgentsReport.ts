// SPDX-License-Identifier: AGPL-3.0-only
// The agents report of one computer or task, read when a page or a panel
// shows it and its last reading is older than FRESH_MS, and again on Read
// again. The last report of each target is kept in the store for as long as
// the window lives, so a computer that stopped answering or a task that is
// paused still draws what stood there, a page opened again soon asks nothing,
// and every panel showing one target draws one read. The host saying the
// agents there changed reads it again.
import { useCallback, useEffect, useState } from "react";
import { isLocalWorkspace, placeOf, type AgentsReport, type AgentsTarget, type PlaceView, type WorkspaceView } from "@wsp/protocol";
import { forgetHeld, heldValue, useHeld } from "../../protocol/held.js";
import { useStore } from "../../protocol/store.js";
import { AGENTS_LIST_WORDS } from "./agentsRows.js";

/** How long a reading stands before showing the page asks for another; Read again asks at once. */
export const FRESH_MS = 5 * 60_000;

const KEY = "agents:";

/** The report this window last read off a target, without asking for one: what a settings search reads. */
export const keptAgentsReport = (target: AgentsTarget): AgentsReport | undefined => heldValue<AgentsReport>(KEY + JSON.stringify(target));

/** Forgets every report this window kept, for a test that starts from a first window. */
export const forgetAgentsReports = (): void => forgetHeld(KEY);

/** What a thread's agents, skills and servers are read off: a thread on a box reads that box for its project, the
 * report the box's page and its acts share, and any other thread reads its own workspace. */
export function threadAgentsTarget(workspace: WorkspaceView, places: readonly PlaceView[]): AgentsTarget {
  const place = placeOf(places, workspace);
  return !isLocalWorkspace(workspace) && place?.kind === "computer" ? { placeId: place.id, project: workspace.project.id } : { workspaceId: workspace.id };
}

/** The host names a computer that changed by its id alone, which is news to a read of one project there too. */
const sameComputer = (changed: AgentsTarget, read: AgentsTarget): boolean => "placeId" in changed && "placeId" in read && changed.placeId === read.placeId;

interface ReportState {
  readonly key: string | null;
  readonly report: AgentsReport | null;
  readonly reading: boolean;
  /** The one sentence the host refused the read with, while no report stands in its place. */
  readonly error: string | null;
  /** When the report shown was read, in wall-clock ms; null before the first. */
  readonly readAt: number | null;
}

export function useAgentsReport(target: AgentsTarget | null): ReportState & { refresh: () => void } {
  const api = useStore(s => s.api);
  const key = target === null ? null : JSON.stringify(target);
  const [asked, setAsked] = useState(0);
  const read = api?.agentsRead;
  const held = useHeld<AgentsReport>(key === null ? null : KEY + key, read === undefined || key === null ? undefined : () => read(JSON.parse(key) as AgentsTarget), { holdMs: FRESH_MS, asked });
  const refresh = useCallback(() => setAsked(n => n + 1), []);
  // A sign-in, a key or the wsp tools written there changes what the report reads, so it is read again.
  useEffect(() => {
    if (key === null || api?.subscribe === undefined) return;
    return api.subscribe(event => {
      if (event.type !== "agents.changed") return;
      if (event.target === undefined || JSON.stringify(event.target) === key || sameComputer(event.target, JSON.parse(key) as AgentsTarget)) refresh();
    });
  }, [api, key, refresh]);
  const shown: ReportState = { key, report: held.value ?? null, reading: held.reading, error: held.error?.message ?? null, readAt: held.answeredAt ?? null };
  // A client with no such read says so once, rather than standing the bars of a read that never comes.
  return { ...shown, ...(key !== null && api !== null && read === undefined && shown.report === null ? { error: AGENTS_LIST_WORDS.noReader } : {}), refresh };
}
