// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's actions, one registry: what a workspace row, the palette,
// the Machine tab and the row's context menu offer for one machine.
import { CopyIcon, FolderInputIcon, FolderOutputIcon, GlobeIcon, GitForkIcon, MessageSquarePlusIcon, PaletteIcon, PauseIcon, PencilIcon, PlayIcon, RefreshCwIcon, ServerIcon, ShapesIcon, SquareTerminalIcon, Trash2Icon } from "lucide-react";
import { NO_REBUILD_NEEDED, isBilling, kindWords, machineWord, needsRebuild, undrivenRefusal, workspaceKind, workspaceState, type LookPart, type MachineState, type ReachState, type WorkspaceKind, type WorkspacePhase, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import {
  CLIENT_CANNOT_EXPORT,
  CLIENT_CANNOT_FORGET,
  CLIENT_CANNOT_IMPORT,
  CLIENT_CANNOT_LOOK,
  CLIENT_CANNOT_REBUILD,
  CLIENT_CANNOT_RENAME_WORKSPACE,
  FORGET_HINT,
  NEW_THREAD_WAITS,
  NO_WORKSPACE_FORK,
  PROJECTS_WAIT,
  REBUILD_HINT,
  WORKSPACE_WORDS,
  forgetRefusal,
  openBrowserRefusal,
  openTerminalRefusal,
  phaseButtonWord,
  phaseCannot,
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
  /** What kind of machine it is; the verbs only wsp's own forks take read it. */
  readonly kind: WorkspaceKind;
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
    kind: workspaceKind(workspace),
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
  /** Opens the name box on the workspace's own row; the row is the only editor, as it is for a thread. */
  readonly rename?: ((workspaceId: string) => void) | undefined;
  /** Opens the picker for one fact of the workspace's look; absent on a client whose host cannot hold it. */
  readonly pickLook?: ((workspaceId: string, part: LookPart) => void) | undefined;
  /** Open the trip's dialog; absent on a client whose host cannot read or land folders here. */
  readonly importProject?: ((workspaceId: string) => void) | undefined;
  readonly exportProject?: ((workspaceId: string) => void) | undefined;
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
    // A machine wsp neither forked nor pays for takes neither verb, in the runtime's own sentence and the verb this
    // slot's own button offers, so what is offered and what would be thrown say the same thing.
    refusal: target => (kindWords(target.kind).driven ? phaseRefusal(stateOf(target)) : undrivenRefusal(target.displayName, machineWord(target.kind), phaseCannot(stateOf(target)))),
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
    id: "import-project",
    group: "project",
    icon: () => FolderInputIcon,
    searchTerms: ["import project", "import folder", "upload"],
    title: () => WORKSPACE_WORDS.importProject,
    refusal: (target, verbs) => (dead(target) ? PROJECTS_WAIT : verbs.importProject === undefined ? CLIENT_CANNOT_IMPORT : null),
    run: (target, verbs) => verbs.importProject?.(target.id),
  },
  {
    id: "export-project",
    group: "project",
    icon: () => FolderOutputIcon,
    searchTerms: ["export project", "export folder", "download", "bring home"],
    title: () => WORKSPACE_WORDS.exportProject,
    refusal: (target, verbs) => (dead(target) ? PROJECTS_WAIT : verbs.exportProject === undefined ? CLIENT_CANNOT_EXPORT : null),
    run: (target, verbs) => verbs.exportProject?.(target.id),
  },
  {
    id: "rename",
    group: "edit",
    icon: () => PencilIcon,
    searchTerms: ["rename workspace"],
    title: () => WORKSPACE_WORDS.rename,
    rowLabel: target => rowVerb("Rename", target.displayName),
    refusal: (_target, verbs) => (verbs.rename === undefined ? CLIENT_CANNOT_RENAME_WORKSPACE : null),
    run: (target, verbs) => verbs.rename?.(target.id),
  },
  {
    id: "icon",
    group: "edit",
    labs: true,
    icon: () => ShapesIcon,
    searchTerms: ["workspace icon", "change icon", "glyph", "symbol", "space icon"],
    title: () => WORKSPACE_WORDS.icon,
    rowLabel: target => rowVerb("Change the icon of", target.displayName),
    refusal: (_target, verbs) => (verbs.pickLook === undefined ? CLIENT_CANNOT_LOOK : null),
    run: (target, verbs) => verbs.pickLook?.(target.id, "glyph"),
  },
  {
    id: "theme",
    group: "edit",
    labs: true,
    icon: () => PaletteIcon,
    searchTerms: ["workspace colour", "workspace color", "theme colour", "tint", "hue", "gradient", "space theme"],
    title: () => WORKSPACE_WORDS.theme,
    rowLabel: target => rowVerb("Edit the theme colour of", target.displayName),
    refusal: (_target, verbs) => (verbs.pickLook === undefined ? CLIENT_CANNOT_LOOK : null),
    run: (target, verbs) => verbs.pickLook?.(target.id, "theme"),
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
