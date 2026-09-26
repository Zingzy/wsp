// SPDX-License-Identifier: AGPL-3.0-only
// The lines a workspace's own row carried before the sidebar drew threads, said
// as notices with the same words: what the runtime is doing to a machine's
// daemon, a daemon that is not there, a drop with memory near full, and what a
// bring back answered. A standing line is keyed and stands until it clears; a
// bring back is said once, when its answer arrives.
import { kindWords, machineLacksShort, outOfMemoryRowLine, workspaceKind, type BringBackResult, type MemoryReading, type ReachState, type WorkspaceKindWords } from "@wsp/protocol";
import { useEffect, useRef } from "react";
import { broughtBackRowLine } from "../actions/format.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { useOutOfMemoryReadings } from "../machine/live.js";
import { useSidebarProjects, useStore } from "../protocol/store.js";
import { addNotice, useNotices, type NoticeKind } from "./store.js";

/** The line for a daemon that is not there: no-daemon is a machine that answers with nothing on the daemon's port,
 * unsupported one with no daemon road at all, which says only what that machine said it lacks. Nothing on a kind
 * whose machines serve no daemon. */
export function daemonGoneLine(reach: ReachState | null, kind: WorkspaceKindWords, lacks?: string): string | undefined {
  if (!kind.daemon) return undefined;
  if (reach === "no-daemon") return "no daemon answering";
  if (reach !== "unsupported" || kind.driven || lacks === undefined) return undefined;
  return machineLacksShort(lacks);
}

/** What the runtime is doing to a machine's daemon, or why its last attempt failed; the live status leads. */
export function daemonNote(project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string | undefined {
  return project.status !== null ? project.status.daemonNote : project.workspace.daemonNote;
}

/** What a bring back answered, with the host's own sentence for a push that opened no pull request after it. */
export function broughtBackLine(back: Pick<BringBackResult, "branch" | "pr" | "note">): string {
  const line = broughtBackRowLine(back);
  return back.note === undefined ? line : `${line}: ${back.note}`;
}

export interface StandingLine {
  readonly key: string;
  readonly kind: NoticeKind;
  readonly text: string;
}

/** The lines one workspace stands on now, each under a key of its own so it is said once and ends when it clears. */
export function standingLines(project: Pick<SidebarProjectSnapshot, "id" | "status" | "workspace" | "reach">, memory: MemoryReading | undefined): StandingLine[] {
  const gone = daemonGoneLine(project.reach, kindWords(workspaceKind(project.workspace)), (project.status ?? project.workspace).daemonRefusedAt?.why);
  const note = daemonNote(project);
  return [
    ...(note === undefined ? [] : [{ key: `line:${project.id}:daemon`, kind: "note" as const, text: note }]),
    ...(gone === undefined ? [] : [{ key: `line:${project.id}:daemon-gone`, kind: "error" as const, text: gone }]),
    ...(memory === undefined ? [] : [{ key: `line:${project.id}:memory`, kind: "error" as const, text: outOfMemoryRowLine(memory) }]),
  ];
}

export function useWorkspaceLineNotices(): void {
  const projects = useSidebarProjects();
  const memory = useOutOfMemoryReadings(projects);
  const said = useRef(new Map<string, string>());
  useEffect(() => {
    const now = new Map(projects.flatMap(p => standingLines(p, memory[p.id]).map(line => [line.key, { ...line, where: p.displayName }] as const)));
    for (const key of said.current.keys()) if (!now.has(key)) useNotices.getState().end(key);
    for (const [key, line] of now) if (said.current.get(key) !== line.text) addNotice({ kind: line.kind, text: line.text, where: line.where, key });
    said.current = new Map([...now].map(([key, line]) => [key, line.text]));
  }, [projects, memory]);

  const broughtBack = useStore(s => s.broughtBack);
  const heard = useRef(broughtBack);
  useEffect(() => {
    for (const [workspaceId, back] of Object.entries(broughtBack)) {
      if (heard.current[workspaceId] === back) continue;
      const where = useStore.getState().workspaces.find(w => w.id === workspaceId)?.name;
      addNotice({ kind: "done", text: broughtBackLine(back), ...(where === undefined ? {} : { where }) });
    }
    heard.current = broughtBack;
  }, [broughtBack]);
}
