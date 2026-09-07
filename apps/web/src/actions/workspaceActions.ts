// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's actions, one registry: what a workspace row, the palette,
// the Machine tab and the row's context menu offer for one machine.
import { CopyIcon, GlobeIcon, GitForkIcon, MessageSquarePlusIcon, PauseIcon, PencilIcon, PlayIcon, RefreshCwIcon, ServerIcon, SquareTerminalIcon, Trash2Icon } from "lucide-react";
import { isBilling, needsRebuild, workspaceState, type MachineState, type ReachState, type WorkspacePhase, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import {
  CLIENT_CANNOT_FORGET,
  CLIENT_CANNOT_REBUILD,
  FORGET_HINT,
  NEW_THREAD_WAITS,
  NO_REBUILD_NEEDED,
  NO_WORKSPACE_FORK,
  NO_WORKSPACE_RENAME,
  REBUILD_HINT,
  WORKSPACE_WORDS,
  forgetRefusal,
  openBrowserRefusal,
  openTerminalRefusal,
  phaseButtonWord,
  phaseHint,
  phaseRefusal,
  phaseWord,
  rowNewThread,
  rowVerb,
} from "./format.js";
import type { ActionEntry } from "./registry.js";

/** What the enabled rules read: the workspace's phase, and the machine state, reach and reason of its status when one has arrived. */
export interface WorkspaceTarget {
  readonly id: string;
  readonly displayName: string;
  readonly machineId: string;
  readonly phase: WorkspacePhase;
  readonly machineState: MachineState | null;
  readonly reach: ReachState | null;
  /** The provider's or the runtime's words on why the machine is gone or a zombie; null while it answers. */
  readonly reason: string | null;
}

/** The one target every surface builds from the record and its status: the status leads where it has arrived. */
export function workspaceTarget(workspace: WorkspaceView, status: WorkspaceStatus | null): WorkspaceTarget {
  return {
    id: workspace.id,
    displayName: workspace.name,
    machineId: status?.machineId ?? workspace.machineId,
    phase: status?.phase ?? workspace.phase,
    machineState: status?.machineState ?? null,
    reach: status?.reach.state ?? null,
    reason: status?.reason ?? workspace.gone ?? null,
  };
}

/** The verbs the client has for a workspace; an absent one is a client without it, and the entry says so. */
export interface WorkspaceVerbs {
  /** Pauses a running workspace, wakes a paused one. */
  readonly togglePhase: (workspaceId: string) => Promise<void>;
  readonly openTerminal: (workspaceId: string) => Promise<void>;
  readonly openBrowser: (workspaceId: string) => void;
  readonly openMachine: (workspaceId: string) => void;
  readonly newThread: (workspaceId: string) => void;
  readonly copyText: (text: string) => Promise<void>;
  readonly rebuild?: ((workspaceId: string) => Promise<void>) | undefined;
  /** Opens the confirmation; the dialog itself asks the host. */
  readonly forget?: ((workspaceId: string) => void) | undefined;
}

const stateOf = (target: WorkspaceTarget): WorkspaceState => workspaceState(target);
const dead = (target: WorkspaceTarget): boolean => needsRebuild(target);

export const workspaceActions: ReadonlyArray<ActionEntry<WorkspaceTarget, WorkspaceVerbs>> = [
  {
    id: "phase",
    group: "state",
    icon: target => (isBilling(stateOf(target)) ? PauseIcon : PlayIcon),
    searchTerms: ["pause workspace", "nap", "sleep", "wake workspace", "resume", "start"],
    title: target => phaseWord(stateOf(target)),
    rowLabel: target => rowVerb(phaseWord(stateOf(target)).split(" ")[0]!, target.displayName),
    buttonWord: target => phaseButtonWord(stateOf(target)),
    hint: target => phaseHint(stateOf(target)),
    refusal: target => phaseRefusal(stateOf(target)),
    run: (target, verbs) => verbs.togglePhase(target.id),
  },
  {
    id: "rebuild",
    group: "state",
    icon: () => RefreshCwIcon,
    searchTerms: ["rebuild machine", "zombie", "gone", "replace"],
    title: () => WORKSPACE_WORDS.rebuild,
    rowLabel: target => rowVerb("Rebuild", target.displayName),
    buttonWord: () => "Rebuild",
    hint: target => target.reason ?? REBUILD_HINT,
    refusal: (target, verbs) => (!dead(target) ? NO_REBUILD_NEEDED : verbs.rebuild === undefined ? CLIENT_CANNOT_REBUILD : null),
    run: (target, verbs) => verbs.rebuild?.(target.id),
  },
  {
    id: "new-thread",
    group: "open",
    icon: () => MessageSquarePlusIcon,
    shortcutCommand: "chat.new",
    searchTerms: ["new thread", "new chat", "new session"],
    title: () => WORKSPACE_WORDS.newThread,
    rowLabel: target => rowNewThread(target.displayName),
    refusal: target => (dead(target) ? NEW_THREAD_WAITS : null),
    run: (target, verbs) => verbs.newThread(target.id),
  },
  {
    id: "open-terminal",
    group: "open",
    icon: () => SquareTerminalIcon,
    shortcutCommand: "terminal.toggle",
    searchTerms: ["open terminal", "new terminal", "shell"],
    title: () => WORKSPACE_WORDS.openTerminal,
    refusal: target => openTerminalRefusal(stateOf(target)),
    run: (target, verbs) => verbs.openTerminal(target.id),
  },
  {
    id: "open-browser",
    group: "open",
    icon: () => GlobeIcon,
    shortcutCommand: "preview.toggle",
    searchTerms: ["open browser", "preview", "ports"],
    title: () => WORKSPACE_WORDS.openBrowser,
    refusal: target => openBrowserRefusal(stateOf(target)),
    run: (target, verbs) => verbs.openBrowser(target.id),
  },
  {
    id: "open-machine",
    group: "open",
    icon: () => ServerIcon,
    searchTerms: ["open machine", "usage", "lineage", "upgrade"],
    title: () => WORKSPACE_WORDS.openMachine,
    refusal: () => null,
    run: (target, verbs) => verbs.openMachine(target.id),
  },
  {
    id: "rename",
    group: "edit",
    icon: () => PencilIcon,
    searchTerms: ["rename workspace"],
    title: () => WORKSPACE_WORDS.rename,
    refusal: () => NO_WORKSPACE_RENAME,
    run: () => {},
  },
  {
    id: "fork",
    group: "edit",
    icon: () => GitForkIcon,
    searchTerms: ["fork workspace", "duplicate", "clone"],
    title: () => WORKSPACE_WORDS.fork,
    refusal: () => NO_WORKSPACE_FORK,
    run: () => {},
  },
  {
    id: "copy-id",
    group: "copy",
    icon: () => CopyIcon,
    searchTerms: ["copy machine id", "copy id"],
    title: () => WORKSPACE_WORDS.copyId,
    refusal: () => null,
    run: (target, verbs) => verbs.copyText(target.machineId),
  },
  {
    id: "forget",
    group: "remove",
    icon: () => Trash2Icon,
    destructive: true,
    searchTerms: ["forget workspace", "delete workspace", "remove"],
    title: () => WORKSPACE_WORDS.forget,
    rowLabel: target => rowVerb("Forget", target.displayName),
    buttonWord: () => "Forget",
    hint: () => FORGET_HINT,
    refusal: (target, verbs) => forgetRefusal(stateOf(target)) ?? (verbs.forget === undefined ? CLIENT_CANNOT_FORGET : null),
    run: (target, verbs) => verbs.forget?.(target.id),
  },
];
