// SPDX-License-Identifier: AGPL-3.0-only
import { threadKeyOf, type HarnessCatalog, type SessionView } from "@wsp/protocol";
import type { State } from "./types.js";

export const NO_SESSIONS: SessionView[] = [];

/** The selected workspace's id, or null while a creation row is selected: no command may act on a creation's key. */
/** The workspace selected, or none while the selection is a workspace still being made. */
export const selectedWorkspaceIdOf = (s: Pick<State, "selectedId" | "creations">): string | null => (s.selectedId !== null && s.creations.some(c => c.key === s.selectedId) ? null : s.selectedId);

type Catalogs = Pick<State, "harnesses" | "harnessesByWorkspace">;

const withoutAccess = new WeakMap<HarnessCatalog[], HarnessCatalog[]>();

/** The host-wide lists with their access modes dropped. Which mode a thread starts at is a fact about the machine it
 * runs on, and the runtime decides it there, once, against that machine's kind: a machine the person keeps asks
 * before a tool, a throwaway fork runs every tool. The host-wide lists were read against no machine, so they answer
 * models and efforts for a workspace still waiting for its own and answer no access at all, the agent's own lists
 * beside them included. The stripped array is kept beside the one it came from, so the selector hands React the same
 * reading every render. */
function hostWide(catalogs: HarnessCatalog[]): HarnessCatalog[] {
  const known = withoutAccess.get(catalogs);
  if (known !== undefined) return known;
  const stripped = catalogs.map(c => ({ ...c, permissionModes: [], ...(c.unshaped === undefined ? {} : { unshaped: { ...c.unshaped, permissionModes: [] } }) }));
  withoutAccess.set(catalogs, stripped);
  return stripped;
}

/** The one rule for which catalogs answer for a workspace, so a surface reading many workspaces' rows and one
 * reading its own read the same thing. */
export const catalogsIn = (s: Catalogs, workspaceId: string | null): HarnessCatalog[] =>
  (workspaceId !== null ? s.harnessesByWorkspace[workspaceId] : undefined) ??
  (workspaceId !== null && (isProjectHomeKey(workspaceId) || isCreationKey(workspaceId)) ? s.harnesses : hostWide(s.harnesses));

/** The key a project's home composer keeps its draft and picks under until its send makes a workspace. A home has
 * no machine of its own, so it reads the host-wide lists whole, access modes included, which is what the workspace
 * its send makes is picked from. */
const PROJECT_HOME_PREFIX = "project:";
export const projectHomeKey = (projectId: string): string => `${PROJECT_HOME_PREFIX}${projectId}`;
export const isProjectHomeKey = (key: string): boolean => key.startsWith(PROJECT_HOME_PREFIX);
/** The project a composer's send lands in: its home's, the creation's, or the workspace's own. */
export const projectOfKey = (s: Pick<State, "workspaces" | "creations">, key: string): string | undefined =>
  isProjectHomeKey(key) ? key.slice(PROJECT_HOME_PREFIX.length) : (s.creations.find(c => c.key === key)?.project ?? s.workspaces.find(w => w.id === key)?.project?.id);
/** A workspace being made reads the lists as its project's home does, since they are what its workspace is picked from. */
export const CREATION_PREFIX = "creating:";
export const isCreationKey = (key: string): boolean => key.startsWith(CREATION_PREFIX);
export const catalogIn = (s: Catalogs, workspaceId: string | null, harness: string): HarnessCatalog | null =>
  catalogsIn(s, workspaceId).find(c => c.harness === harness) ?? null;

/** The rule under useThreadSessions, for a reader outside React that has to agree with what the centre draws. */
export function threadRows(sessions: ReadonlyArray<SessionView>, workspaceId: string | null, threadKey: string): ReadonlyArray<SessionView> {
  const own = sessions.filter(row => threadKeyOf(row) === threadKey);
  if (own.length > 0 || threadKey !== workspaceId) return own;
  const latest = sessions.at(-1);
  return latest === undefined ? NO_SESSIONS : [latest];
}

/** Whether the centre of this state draws a thread: neither Settings nor a new thread's page over it, its workspace
 * selected, and the thread selected or, with none selected, the workspace's latest row. A thread with no row read
 * yet counts where it is the one selected. */
export function threadOnScreen(
  s: Pick<State, "settingsOpen" | "freshThread" | "selectedId" | "selectedThreadId" | "sessions">,
  at: { workspaceId: string; threadId?: string | undefined; sessionId?: string | undefined },
): boolean {
  if (s.settingsOpen || s.freshThread || s.selectedId !== at.workspaceId) return false;
  const shown = threadRows(s.sessions[at.workspaceId] ?? [], at.workspaceId, s.selectedThreadId ?? at.workspaceId).at(-1);
  return shown === undefined ? s.selectedThreadId === null || s.selectedThreadId === at.threadId : threadKeyOf(shown) === (at.threadId ?? at.sessionId);
}

/** The workspace whose rows hold a thread, where its composer keeps its draft. */
export function threadWorkspaceIn(sessions: Readonly<Record<string, ReadonlyArray<SessionView>>>, threadId: string): string | null {
  for (const [workspaceId, rows] of Object.entries(sessions)) if (rows.some(row => threadKeyOf(row) === threadId)) return workspaceId;
  return null;
}
