// SPDX-License-Identifier: AGPL-3.0-only
// The model, effort, access and project pickers inside the composer box. Each lists
// what the runtime's catalog says the harness's CLI takes, asked of the
// binary on the workspace's machine once it runs; a picker whose list is
// empty does not exist. The effort button reads "<effort> · <context>", the
// context alone for a model that takes no effort, and its menu has a Reasoning
// and a Context Window section, each default marked and checked until a pick;
// the access button carries the mode's icon and the mode's short form where
// it has one (its label names the machine on a kept one; the menu row keeps
// the label), and each mode its one line. No button shrinks: the row wraps
// before any of them is cut, so every pick reads whole down to a centre column
// of about 300 px (measured 2026-09-09); the shell keeps the column wider
// than that beside the inline panel. The one label a person writes, the
// project's name, has no bound, so its button alone is capped at the row and
// cuts the name; the menu row says it whole. A pick rides the next
// sessions.start and is remembered per workspace; a turn
// already running keeps its flags and shows them meanwhile. The access pick is
// the exception: it is remembered on the host's own record, so the next thread
// here starts at it whichever client or CLI opens it, and where the harness
// takes a mode change mid-turn it reaches the turn in front of the person too.
// The project pick exists only on a workspace holding projects and only while
// the thread is still to be opened: it reads the runtime's default folder rule
// off the record, its menu is the workspace's projects and other folder, which
// opens the folder picker under the box, and a pick lands on the host's record
// as the workspace's last project, where the runtime reads it for every road.
import { BrainIcon, ChevronDownIcon, CircleSlashIcon, FolderIcon, FolderOpenIcon, HandIcon, LockIcon, LockOpenIcon, PenLineIcon, PencilRulerIcon, ShieldIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_AGENT } from "@wsp/catalog";
import { accessFromNextMessage, contextWindowsFor, effortsFor, type HarnessCatalog, type HarnessModel, type HarnessOption, type WorkspaceProject } from "@wsp/protocol";
import { baseName } from "../../files/entries";
import { useChosenFolder, useDefaultProject, useProjects, useRootStore } from "../../files/root";
import { useHarnessCatalog, useHarnessCatalogs, useLatestSession, useStore, useWorkspace } from "../../protocol/store";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { canPickFolder } from "./ComposerCheckoutRow";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { useComposerOptions, useComposerOptionsStore, type ComposerOptionKey, type PickThreads } from "./composerOptionsStore";
import { effectivePicks, pickedFor, resolveModel, startOptionsFrom, threadPicks, type ComposerStart, type ResolvedPicks } from "./composerPicks";
import { effortPickerLabel } from "./format";
import type { ChatThreadHandle } from "./useChatThread";

export const DEFAULT_HARNESS = DEFAULT_AGENT.id;

/** One object for a workspace nobody has picked on, so the selector hands the hook the same reference every render. */
const NO_THREADS: PickThreads = {};

/** One icon per permission mode the table knows; a mode it does not gets the shield. */
const ACCESS_ICONS: Readonly<Record<string, LucideIcon>> = {
  default: LockIcon,
  acceptEdits: PenLineIcon,
  plan: PencilRulerIcon,
  bypassPermissions: LockOpenIcon,
  auto: SparklesIcon,
  manual: HandIcon,
  dontAsk: CircleSlashIcon,
  "read-only": LockIcon,
  "workspace-write": PenLineIcon,
  "danger-full-access": LockOpenIcon,
  auto_edit: PenLineIcon,
  yolo: LockOpenIcon,
};

export interface ComposerPicks {
  readonly harness: string;
  readonly catalog: HarnessCatalog | null;
  /** The model the next start runs with, as the pickers show it. */
  readonly model: HarnessModel | null;
  readonly picks: ResolvedPicks | null;
  /** What rides the next sessions.start. */
  readonly startOptions: ComposerStart;
  /** The thread has a turn on this harness, so the rail offers no other. */
  readonly pinned: boolean;
}

/** The composer's picks for a workspace, and the catalog they read from: the machine's once it answered, else the table's. */
export function useComposerPicks(workspaceId: string, thread: ChatThreadHandle): ComposerPicks {
  const latest = useLatestSession(workspaceId);
  const kept = useComposerOptions(workspaceId);
  const pickedOn = useComposerOptionsStore(s => s.pickedOn[workspaceId] ?? NO_THREADS);
  const picked = useMemo(() => pickedFor(kept, thread.view, pickedOn, thread.threadKey), [kept, pickedOn, thread.threadKey, thread.view]);
  const onThread = useMemo(() => threadPicks(latest, thread.view), [latest, thread.view]);
  const pinned = latest !== null && !thread.fresh && (thread.view.entries.length > 0 || thread.view.running);
  const harness = (pinned ? latest.harness : picked.harness ?? latest?.harness) ?? DEFAULT_HARNESS;
  const catalog = useHarnessCatalog(harness, workspaceId);
  const model = useMemo(() => (catalog === null ? null : resolveModel(catalog, { picked: picked.model, thread: onThread.model })), [catalog, picked.model, onThread.model]);
  const picks = useMemo(() => (catalog === null ? null : effectivePicks(catalog, { picked, thread: onThread })), [catalog, picked, onThread]);
  const startOptions = useMemo(() => (catalog === null ? {} : startOptionsFrom(catalog, picked, onThread)), [catalog, picked, onThread]);
  return { harness, catalog, model, picks, startOptions, pinned };
}

/** Asks the workspace's machine for its catalogs once it runs; the table shows until then and stays when it does not answer. */
function useMachineCatalogs(workspaceId: string): void {
  const workspace = useWorkspace(workspaceId);
  const conn = useStore(s => s.conn);
  const load = useStore(s => s.loadHarnesses);
  const running = workspace?.phase === "running";
  useEffect(() => {
    if (running && conn === "live") void load(workspaceId);
  }, [conn, load, running, workspaceId]);
}

const triggerClass = "shrink-0 font-medium text-muted-foreground/70 hover:text-foreground/80";

function DefaultBadge() {
  return <span className="ms-2 rounded border border-border/70 bg-muted/60 px-1 font-mono text-[10px] leading-4 text-muted-foreground">default</span>;
}

function OptionRows({ options }: { options: ReadonlyArray<HarnessOption> }) {
  return options.map(option => {
    const Icon = ACCESS_ICONS[option.value];
    return (
      <MenuRadioItem key={option.value} value={option.value} data-composer-option={option.value} className={option.description !== undefined ? "items-start py-1.5" : undefined}>
        <span className="flex min-w-0 items-start gap-2">
          {Icon !== undefined ? <Icon className="mx-0! mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center">
              <span className="truncate">{option.label}</span>
              {option.isDefault ? <DefaultBadge /> : null}
            </span>
            {option.description !== undefined ? <span className="text-xs leading-4 text-muted-foreground">{option.description}</span> : null}
          </span>
        </span>
      </MenuRadioItem>
    );
  });
}

function EffortPicker({
  workspaceId,
  threadKey,
  efforts,
  contextWindows,
  picks,
}: {
  workspaceId: string;
  /** The thread a window pick belongs to: the window rides inside the model, so it is scoped like one. */
  threadKey: string;
  efforts: HarnessOption[];
  contextWindows: HarnessOption[];
  picks: ResolvedPicks;
}) {
  const pick = useComposerOptionsStore(s => s.pick);
  const label = effortPickerLabel(
    efforts.find(o => o.value === picks.effort),
    contextWindows.find(o => o.value === picks.contextWindow),
  );
  const onPick = (key: ComposerOptionKey) => (next: unknown) => {
    if (typeof next === "string") pick(workspaceId, key, next, threadKey);
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={triggerClass}
        aria-label={`Effort: ${label}`}
        data-composer-picker="effort"
        data-value={picks.effort ?? undefined}
        data-context-window={picks.contextWindow ?? undefined}
      >
        <BrainIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-56">
        {efforts.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Reasoning</MenuGroupLabel>
            <MenuRadioGroup value={picks.effort} onValueChange={onPick("effort")}>
              <OptionRows options={efforts} />
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {efforts.length > 0 && contextWindows.length > 0 ? <MenuSeparator /> : null}
        {contextWindows.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Context Window</MenuGroupLabel>
            <MenuRadioGroup value={picks.contextWindow} onValueChange={onPick("contextWindow")}>
              <OptionRows options={contextWindows} />
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** One turn of this workspace's, as a pick made while it runs needs it: the runtime's id for the session, which is
 * what sessions.access takes, and the turn the note belongs to. */
export interface RunningTurn {
  readonly sessionId: string;
  readonly turnId: string;
}

/** The one road an access pick takes. It goes onto the host's record, where the next thread in this workspace reads
 * it whoever opens it, and into the turn in front of the person when one runs: Claude Code moves a running turn to
 * another mode over its control channel, and a harness that takes no such change answers unsupported. `line` is what
 * the composer says then, and it stands only while the turn the pick missed is still the running one. */
export function useAccessPick(workspaceId: string, running: RunningTurn | null): { pick: (mode: string, label: string) => void; line: string | null } {
  const api = useStore(s => s.api);
  const setPreferences = useStore(s => s.setPreferences);
  const [note, setNote] = useState<{ turnId: string; line: string } | null>(null);
  const pick = useCallback(
    (mode: string, label: string) => {
      setNote(null);
      void setPreferences({ access: { [workspaceId]: mode } });
      if (running === null) return;
      const missed = (): void => setNote({ turnId: running.turnId, line: accessFromNextMessage(label) });
      if (api?.setSessionAccess === undefined) {
        missed();
        return;
      }
      void api.setSessionAccess(running.sessionId, mode).then(outcome => {
        if (outcome !== "set") missed();
      }, missed);
    },
    [api, running, setPreferences, workspaceId],
  );
  return { pick, line: note !== null && note.turnId === running?.turnId ? note.line : null };
}

function AccessPicker({ modes, value, onPick }: { modes: ReadonlyArray<HarnessOption>; value: string | null; onPick: (mode: string, label: string) => void }) {
  const current = modes.find(o => o.value === value);
  const Icon = (value !== null ? ACCESS_ICONS[value] : undefined) ?? ShieldIcon;
  const label = current?.label ?? "Access";
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={triggerClass}
        aria-label={`Access: ${label}`}
        data-composer-picker="permissionMode"
        data-value={value ?? undefined}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{current?.short ?? label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
        <MenuRadioGroup
          value={value}
          onValueChange={next => {
            const mode = modes.find(o => o.value === next);
            if (mode !== undefined) onPick(mode.value, mode.label);
          }}
        >
          <OptionRows options={modes} />
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The word other folder wears in the project menu and, once one is chosen, the folder's own name on the trigger. */
export const OTHER_FOLDER = "other folder";

/** The project pick: the default project's name, or the chosen folder's last segment, or the word Project while two
 * or more projects wait for a pick. A project pick lands on the host's record and clears any chosen folder, so the
 * rule's answer is the folder shown; other folder hands the pick to the folder picker under the box. The button is
 * capped at the row's width, since a folder's name is as long as the person made it. */
function ProjectPicker({ workspaceId, projects, onOtherFolder }: { workspaceId: string; projects: readonly WorkspaceProject[]; onOtherFolder: () => void }) {
  const project = useDefaultProject(workspaceId);
  const chosen = useChosenFolder(workspaceId);
  const setPreferences = useStore(s => s.setPreferences);
  const unchoose = useRootStore(s => s.unchoose);
  const follow = useRootStore(s => s.follow);
  const value = chosen === null ? project?.name ?? null : null;
  const label = chosen !== null ? baseName(chosen) : project?.name ?? "Project";
  const Icon = chosen !== null ? FolderOpenIcon : FolderIcon;
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={`${triggerClass} max-w-full`}
        aria-label={`Project: ${label}`}
        data-composer-picker="project"
        data-value={value ?? undefined}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span data-composer-project-name className="min-w-0 truncate font-mono">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
        <MenuRadioGroup
          value={value}
          onValueChange={next => {
            const picked = projects.find(p => p.name === next);
            if (picked === undefined) return;
            unchoose(workspaceId);
            follow(workspaceId, picked.dest);
            void setPreferences({ project: { [workspaceId]: picked.name } });
          }}
        >
          {projects.map(p => (
            <MenuRadioItem key={p.name} value={p.name} data-composer-project={p.name} title={p.dest}>
              <span className="flex min-w-0 items-center gap-2">
                <FolderIcon className="mx-0! size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-mono">{p.name}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={onOtherFolder} data-composer-project-other>
          <FolderOpenIcon />
          <span className="truncate">{OTHER_FOLDER}</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function ComposerOptionPickers({
  workspaceId,
  thread,
  onPickAccess,
  onOtherFolder,
}: {
  workspaceId: string;
  thread: ChatThreadHandle;
  onPickAccess: (mode: string, label: string) => void;
  /** Opens the folder picker under the box, where the project menu's other folder row sends the pick. */
  onOtherFolder: () => void;
}) {
  useMachineCatalogs(workspaceId);
  const pick = useComposerOptionsStore(s => s.pick);
  const catalogs = useHarnessCatalogs(workspaceId);
  const projects = useProjects(workspaceId);
  const { catalog, model, picks, pinned } = useComposerPicks(workspaceId, thread);
  if (catalog === null || picks === null) return null;
  const efforts = effortsFor(catalog, model);
  const contextWindows = contextWindowsFor(catalog, model);
  return (
    <>
      <ComposerModelPicker
        catalogs={catalogs}
        catalog={catalog}
        model={model}
        pinned={pinned}
        onPickHarness={harness => pick(workspaceId, "harness", harness)}
        onPickModel={(harness, value) => {
          if (harness !== catalog.harness) pick(workspaceId, "harness", harness);
          pick(workspaceId, "model", value, thread.threadKey);
        }}
      />
      {efforts.length > 0 || contextWindows.length > 0 ? <EffortPicker workspaceId={workspaceId} threadKey={thread.threadKey} efforts={efforts} contextWindows={contextWindows} picks={picks} /> : null}
      {catalog.permissionModes.length > 0 ? <AccessPicker modes={catalog.permissionModes} value={picks.permissionMode} onPick={onPickAccess} /> : null}
      {projects.length > 0 && canPickFolder(thread) ? <ProjectPicker workspaceId={workspaceId} projects={projects} onOtherFolder={onOtherFolder} /> : null}
    </>
  );
}
