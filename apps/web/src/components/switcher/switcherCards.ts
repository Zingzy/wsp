// SPDX-License-Identifier: AGPL-3.0-only
// One card per target, built from the same snapshot the sidebar draws: a
// workspace card carries its name and its top thread, a thread card the
// thread's title, its status and the computer it runs on.
// Nothing here decides an order or a thread of its own.
import type { PlaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../../adapt/index.js";
import { topSidebarThread } from "../../sidebar/Sidebar.logic.js";
import { computerName } from "../../sidebar/workspaceRows.js";
import type { SwitchTarget } from "../../shell/workspaceSwitcher.js";

/** A workspace's card: its name, its top thread's title and the picture the shell last took of its page. */
export interface WorkspaceCard {
  readonly workspaceId: string;
  readonly threadId: null;
  readonly name: string;
  readonly threadTitle: string | null;
  /** Absent in a browser tab, which cannot take one. */
  readonly image: string | null;
}

/** A thread's card: its title, the thread its status is read off, and the computer it runs on by its name. No
 * picture: the threads all share one page. */
export interface ThreadCard {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly name: string;
  readonly thread: SidebarThreadSnapshot;
  readonly place: string;
}

export type SwitcherCard = WorkspaceCard | ThreadCard;

export interface SwitcherCardsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly places: readonly PlaceView[];
  /** The targets the overlay froze when it opened; a workspace or thread that has since gone leaves no card. */
  readonly targets: ReadonlyArray<SwitchTarget>;
  readonly images: Readonly<Record<string, string>>;
  /** The workspace the person is on, whose card names the thread the sidebar pins rather than its top one. */
  readonly currentId: string | null;
  /** The thread pinned in the sidebar, which belongs to the current workspace alone. */
  readonly pinnedThreadId: string | null;
}

export function buildSwitcherCards(input: SwitcherCardsInput): SwitcherCard[] {
  const byId = new Map(input.projects.map(project => [project.id, project]));
  return input.targets.flatMap(({ workspaceId, threadId }): SwitcherCard[] => {
    const project = byId.get(workspaceId);
    if (project === undefined) return [];
    if (threadId !== null) {
      const thread = project.threads.find(t => t.threadId === threadId);
      if (thread === undefined) return [];
      return [{ workspaceId, threadId, name: thread.title, thread, place: computerName(input.places, project) }];
    }
    const current = workspaceId === input.currentId;
    const pinned = current && input.pinnedThreadId !== null ? project.threads.find(t => t.id === input.pinnedThreadId) : undefined;
    const thread = pinned ?? topSidebarThread(project.threads);
    return [
      {
        workspaceId,
        threadId: null,
        name: project.displayName,
        threadTitle: thread?.title ?? null,
        image: input.images[workspaceId] ?? null,
      },
    ];
  });
}
