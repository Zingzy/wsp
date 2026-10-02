// SPDX-License-Identifier: AGPL-3.0-only
// One card per thread target, built from the same snapshot the sidebar draws:
// the thread's title, its status, the computer it runs on, the project its
// workspace holds and the picture the shell last took of it.
// Nothing here decides an order or a thread of its own.
import type { PlaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../../adapt/index.js";
import { computerName } from "../../sidebar/workspaceRows.js";
import type { SwitchTarget } from "../../shell/workspaceSwitcher.js";

export interface SwitcherCard {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly name: string;
  readonly thread: SidebarThreadSnapshot;
  readonly place: string;
  /** Whose glyph the well draws while it holds no picture. */
  readonly projectId: string;
  /** Absent in a browser tab, which cannot take one. */
  readonly image: string | null;
}

export interface SwitcherCardsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly places: readonly PlaceView[];
  /** The targets the overlay froze when it opened; a thread that has since gone leaves no card. */
  readonly targets: ReadonlyArray<SwitchTarget>;
  /** The pictures the shell holds, by thread. */
  readonly images: Readonly<Record<string, string>>;
}

export function buildSwitcherCards(input: SwitcherCardsInput): SwitcherCard[] {
  const byId = new Map(input.projects.map(project => [project.id, project]));
  return input.targets.flatMap(({ workspaceId, threadId }): SwitcherCard[] => {
    const project = byId.get(workspaceId);
    const thread = project?.threads.find(t => t.threadId === threadId);
    if (project === undefined || thread === undefined) return [];
    return [{ workspaceId, threadId, name: thread.title, thread, place: computerName(input.places, project), projectId: project.workspace.project.id, image: input.images[threadId] ?? null }];
  });
}
