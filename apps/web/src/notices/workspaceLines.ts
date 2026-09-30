// SPDX-License-Identifier: AGPL-3.0-only
// What a workspace's machine says to the person, and what a bring back
// answered. A machine's life (its helper updating, a machine running and not
// answering, a link that ended) never pops as a notice: the host mends those on
// its own. The thread on screen says one line about its machine, in plain
// words, and only where the person has to act: the machine lacks something wsp
// needs, or its memory ran near full. A bring back is said once, when its
// answer arrives.
import { capitalised, kindWords, machineLacksShort, outOfMemoryRowLine, pausedOrPausing, workspaceKind, workspaceStateOf, type BringBackResult, type MemoryReading } from "@wsp/protocol";
import { useEffect, useMemo, useRef } from "react";
import { broughtBackRowLine } from "../actions/format.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { useOutOfMemoryReadings } from "../machine/live.js";
import { useSidebarProjects, useStore } from "../protocol/store.js";
import { copyName } from "../sidebar/workspaceRows.js";
import { addNotice } from "./store.js";

/** What a bring back answered, with the host's own sentence for a push that opened no pull request after it. */
export function broughtBackLine(back: Pick<BringBackResult, "branch" | "pr" | "note">): string {
  const line = broughtBackRowLine(back);
  return back.note === undefined ? line : `${line}: ${back.note}`;
}

/** The line the open thread says about its machine, or null where the person has nothing to do: a machine that
 * lacks what wsp needs to run there, in the first clause of what it said it lacks, or a drop with memory near
 * full. Nothing while it is paused or pausing, which is expected. */
export function machineLine(project: Pick<SidebarProjectSnapshot, "status" | "workspace" | "reach">, memory: MemoryReading | undefined): string | null {
  if (pausedOrPausing(workspaceStateOf(project.workspace, project.status))) return null;
  const kind = kindWords(workspaceKind(project.workspace));
  const lacks = (project.status ?? project.workspace).daemonRefusedAt?.why;
  if (kind.daemon && !kind.driven && project.reach === "unsupported" && lacks !== undefined) return capitalised(machineLacksShort(lacks));
  return memory === undefined ? null : capitalised(outOfMemoryRowLine(memory));
}

/** That line for one workspace, for the thread on screen. */
export function useMachineLine(workspaceId: string): string | null {
  const projects = useSidebarProjects();
  const project = projects.find(p => p.id === workspaceId);
  const watched = useMemo(() => (project === undefined ? [] : [project]), [project]);
  const memory = useOutOfMemoryReadings(watched);
  return project === undefined ? null : machineLine(project, memory[workspaceId]);
}

export function useWorkspaceLineNotices(): void {
  const projects = useSidebarProjects();
  const places = useStore(s => s.places);
  const broughtBack = useStore(s => s.broughtBack);
  const heard = useRef(broughtBack);
  useEffect(() => {
    for (const [workspaceId, back] of Object.entries(broughtBack)) {
      if (heard.current[workspaceId] === back) continue;
      const runs = projects.find(p => p.id === workspaceId);
      const where = runs === undefined ? undefined : copyName(places, runs);
      addNotice({ kind: "done", text: broughtBackLine(back), ...(where === undefined ? {} : { where }) });
    }
    heard.current = broughtBack;
  }, [broughtBack, projects, places]);
}
