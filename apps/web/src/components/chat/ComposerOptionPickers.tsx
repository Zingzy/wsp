// SPDX-License-Identifier: AGPL-3.0-only
// The model, defaults and project pickers inside the composer box. Each lists
// what the runtime's catalog says the harness's CLI takes, asked of the
// binary on the workspace's machine once it runs; a picker whose list is
// empty does not exist. The reasoning effort, the context window and the
// access are one quiet button and one menu: the button reads the picked
// effort and the picked access, each in its short form where the row has one,
// and the menu has a Reasoning, a Context window and an Access group, each
// default marked and checked until a pick, with each access mode's one line
// under it. The button wears the access mode's own icon, since the mode is
// the one pick that says what the agent may touch. No button shrinks: the row wraps
// before any of them is cut, so every pick reads whole down to a centre column
// of about 300 px (measured 2026-09-09); the shell keeps the column wider
// than that beside the inline panel. The one label a person writes, the
// project's name, has no bound, so its button alone is capped at the row and
// cuts the name; the menu row says it whole. A pick is remembered per
// workspace and rides the next sessions.start, except that a thread that has
// run keeps the agent and the access its own rows carry: the model, its
// window and the effort a pick made on such a thread still ride its next
// send, the agent and the access never do. The access pick is
// the exception: it is remembered on the host's own record, so the next thread
// here starts at it whichever client or CLI opens it, and where the harness
// takes a mode change mid-turn it reaches the turn in front of the person too,
// the prompt it is stopped on included; the menu says which of the two a pick
// will do while a turn runs, over the list, before the pick is made.
// The project pick exists only on a workspace holding projects and only while
// the thread is still to be opened: it reads the runtime's default folder rule
// off the record, its menu is the workspace's projects and other folder, which
// opens the folder picker under the box, and a pick lands on the host's record
// as the workspace's last project, where the runtime reads it for every road.
import { ChevronDownIcon, CircleSlashIcon, FolderIcon, FolderOpenIcon, HandIcon, LockIcon, LockOpenIcon, PenLineIcon, PencilRulerIcon, ShieldIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_AGENT } from "@wsp/catalog";
import { ACCESS_REFUSED_LINE, accessReachLine, contextWindowsFor, effortsFor, movesRunningAccess, type HarnessCatalog, type HarnessModel, type HarnessOption, type ProjectRef, type ProjectView } from "@wsp/protocol";
import { baseName } from "../../files/entries";
import { useChosenFolder, useDefaultProject, useProject, useRootStore } from "../../files/root";
import { useHarnessCatalog, useHarnessCatalogs, useLatestSession, useProjects, useStore, useThreadSessions, useWorkspace } from "../../protocol/store";
import { useWhereWord } from "../../sidebar/workspaceRows";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { canPickFolder } from "./ComposerCheckoutRow";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { useComposerDraftStore } from "./composerDraftStore";
import { useComposerOptions, useComposerOptionsStore, type ComposerOptionKey, type PickThreads } from "./composerOptionsStore";
import { effectivePicks, pickedFor, resolveModel, startOptionsFrom, threadPicks, type ComposerStart, type ResolvedPicks } from "./composerPicks";
import { defaultsPickerLabel, DEFAULTS_WORD } from "./format";
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
  /** What rides a start that opens a thread; a send into a thread that has run carries the model and the effort of it. */
  readonly startOptions: ComposerStart;
  /** The thread has a turn on this harness, so the rail offers no other. */
  readonly pinned: boolean;
  /** Nothing here says which agent to run: no turn has run in this workspace, nobody picked, the project
   * remembers none, more than one agent answers and nothing is typed yet. Read as one offer per workspace and
   * never again, since the list stands over the box the ask is typed in. */
  readonly offerAgents: boolean;
}

/** The agent the project's last thread ran, where the agents here carry it: what a fresh thread opens on, so a
 * second piece of work on a project opens where the first one left off instead of on the catalog's first row. An
 * agent the record names that this workspace has no catalog for is dropped, since a composer pointed at one would
 * draw no pickers at all. */
export function rememberedAgent(project: Pick<ProjectView, "lastAgent"> | undefined, catalogs: ReadonlyArray<HarnessCatalog>): string | undefined {
  const last = project?.lastAgent;
  return last !== undefined && catalogs.some(entry => entry.harness === last) ? last : undefined;
}

/** The one offer: taken the first time nothing says which agent to run, and given back when the person types. It
 * is not given back by the pick itself, which is the person reading that agent's models. The store holds the mark,
 * so the offer does not come back when the composer is remounted by a switch of threads, nor when the box is
 * emptied again. */
function useRailOffer(workspaceId: string, conditions: boolean, typing: boolean): boolean {
  const take = useComposerOptionsStore(s => s.takeRailOffer);
  const [offering, setOffering] = useState(false);
  useEffect(() => {
    if (conditions && take(workspaceId)) setOffering(true);
  }, [conditions, take, workspaceId]);
  useEffect(() => {
    if (typing) setOffering(false);
  }, [typing]);
  return offering;
}

/** The record for the workspace's own project, which is where its remembered agent is written. */
function useProjectRecord(workspaceId: string): ProjectView | undefined {
  const ref = useProject(workspaceId);
  const projects = useProjects();
  return ref === null ? undefined : projects.find(entry => entry.id === ref.id);
}

/** The composer's picks for a workspace, and the catalog they read from: the machine's once it answered, else the table's. */
export function useComposerPicks(workspaceId: string, thread: ChatThreadHandle): ComposerPicks {
  const latest = useLatestSession(workspaceId);
  const catalogs = useHarnessCatalogs(workspaceId);
  const project = useProjectRecord(workspaceId);
  const remembered = rememberedAgent(project, catalogs);
  const kept = useComposerOptions(workspaceId);
  const rows = useThreadSessions(workspaceId, thread.threadKey);
  const pickedOn = useComposerOptionsStore(s => s.pickedOn[workspaceId] ?? NO_THREADS);
  const picked = useMemo(() => pickedFor(kept, thread.view, pickedOn, thread.threadKey), [kept, pickedOn, thread.threadKey, thread.view]);
  const onThread = useMemo(() => threadPicks(thread.view, rows), [rows, thread.view]);
  // The agent the open thread runs on, off the newest row its own turns wrote. A workspace runs its threads side
  // by side, so its latest session is as often another thread's: read there, a Codex thread's composer drew
  // Claude Code's models, effort and access, and its send would have run one.
  const own = rows.at(-1)?.harness;
  const pinned = own !== undefined && !thread.fresh && (thread.view.entries.length > 0 || thread.view.running);
  const harness = (pinned ? own : picked.harness ?? latest?.harness ?? remembered) ?? DEFAULT_HARNESS;
  const catalog = useHarnessCatalog(harness, workspaceId);
  const model = useMemo(() => (catalog === null ? null : resolveModel(catalog, { picked: picked.model, thread: onThread.model })), [catalog, picked.model, onThread.model]);
  const picks = useMemo(() => (catalog === null ? null : effectivePicks(catalog, { picked, thread: onThread })), [catalog, picked, onThread]);
  const startOptions = useMemo(() => (catalog === null ? {} : startOptionsFrom(catalog, picked, onThread)), [catalog, picked, onThread]);
  // Only where the record itself says the project has run nothing: a host whose projects list has not arrived
  // knows no better, and opening the rail over a workspace whose last agent is about to land would be a guess.
  // More than one agent, since one leaves nothing to pick. The draft is read as one flag, so the store wakes this
  // only as the box goes from empty to typed in.
  const typing = useComposerDraftStore(s => (s.drafts[workspaceId]?.prompt ?? "") !== "");
  const nothingSaysWhich = project !== undefined && project.lastAgent === undefined && latest === null && picked.harness === undefined && catalogs.length > 1;
  const offerAgents = useRailOffer(workspaceId, !typing && nothingSaysWhich, typing);
  return { harness, catalog, model, picks, startOptions, pinned, offerAgents };
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
            {/* The line under each access mode drops at the narrow width: with it the menu is taller than a phone's
                viewport and its last row was cut across the middle, and the mode's own name is what the row is. */}
            {option.description !== undefined ? <span className="hidden text-xs leading-4 text-muted-foreground sm:block">{option.description}</span> : null}
          </span>
        </span>
      </MenuRadioItem>
    );
  });
}

/** The one quiet menu behind the composer's defaults: the agent's reasoning effort, its context window and the
 * access it starts a turn at, three groups with the agent's own default marked in each. They were three buttons;
 * a person reads the row for the agent, the model and the folder, and these three are what an agent already has a
 * default for. The effort and the window belong to the thread they are picked on; the access goes onto the host's
 * record and, where the harness takes one mid-turn, into the turn in front of the person. */
function DefaultsPicker({
  workspaceId,
  /** The thread an effort or a window pick belongs to: each is something the thread already runs at, so a pick here
   * is a change to this thread and not to every thread of the workspace. */
  threadKey,
  efforts,
  contextWindows,
  modes,
  picks,
  /** What a pick does to the turn running now, over the access list; nothing while no turn runs and the pick only starts one. */
  note,
  onPickAccess,
}: {
  workspaceId: string;
  threadKey: string;
  efforts: HarnessOption[];
  contextWindows: HarnessOption[];
  modes: ReadonlyArray<HarnessOption>;
  picks: ResolvedPicks;
  note: string | null;
  onPickAccess: (mode: string) => void;
}) {
  const pick = useComposerOptionsStore(s => s.pick);
  const access = modes.find(o => o.value === picks.permissionMode);
  const label = defaultsPickerLabel(efforts.find(o => o.value === picks.effort), access);
  const Icon = (picks.permissionMode !== null ? ACCESS_ICONS[picks.permissionMode] : undefined) ?? ShieldIcon;
  const onPick = (key: ComposerOptionKey) => (next: unknown) => {
    if (typeof next === "string") pick(workspaceId, key, next, threadKey);
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={triggerClass}
        aria-label={`${DEFAULTS_WORD}: ${label}`}
        data-composer-picker="defaults"
        data-effort={picks.effort ?? undefined}
        data-context-window={picks.contextWindow ?? undefined}
        data-access={picks.permissionMode ?? undefined}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
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
            <MenuGroupLabel>Context window</MenuGroupLabel>
            <MenuRadioGroup value={picks.contextWindow} onValueChange={onPick("contextWindow")}>
              <OptionRows options={contextWindows} />
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {(efforts.length > 0 || contextWindows.length > 0) && modes.length > 0 ? <MenuSeparator /> : null}
        {modes.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Access</MenuGroupLabel>
            {note !== null ? <MenuGroupLabel data-composer-access-reach>{note}</MenuGroupLabel> : null}
            <MenuRadioGroup
              value={picks.permissionMode}
              onValueChange={next => {
                const mode = modes.find(o => o.value === next);
                if (mode !== undefined) onPickAccess(mode.value);
              }}
            >
              <OptionRows options={modes} />
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
 * it whoever opens it, and into the turn in front of the person when one runs, where the harness's own row says it
 * takes a mode change mid-turn (`movesAccess`, which is what the menu says over its list before the pick). `line`
 * is the refusal that stands under the box when a row saying so came back refused all the same: nothing is said for
 * a harness whose row already said the pick waits, since the person read that before they picked, and nothing for a
 * turn that simply ended. It stands only while the turn it is about is still the running one. */
export function useAccessPick(workspaceId: string, running: RunningTurn | null, threadKey: string, movesRunningTurn: boolean): { pick: (mode: string) => void; line: string | null } {
  const api = useStore(s => s.api);
  const setPreferences = useStore(s => s.setPreferences);
  const stamp = useComposerOptionsStore(s => s.pick);
  const [note, setNote] = useState<{ turnId: string } | null>(null);
  const pick = useCallback(
    (mode: string) => {
      setNote(null);
      void setPreferences({ access: { [workspaceId]: mode } });
      // The mode itself lives on the host's record, which holds one per workspace; the thread it was picked on is
      // kept in the browser beside the other picks, so it paints this thread rather than every thread here.
      stamp(workspaceId, "permissionMode", mode, threadKey);
      if (running === null || !movesRunningTurn || api?.setSessionAccess === undefined) return;
      void api.setSessionAccess(running.sessionId, mode).then(outcome => {
        if (outcome === "unsupported") setNote({ turnId: running.turnId });
      }, () => {});
    },
    [api, movesRunningTurn, running, setPreferences, stamp, threadKey, workspaceId],
  );
  return { pick, line: note !== null && note.turnId === running?.turnId ? ACCESS_REFUSED_LINE : null };
}

/** The word other folder wears in the project menu and, once one is chosen, the folder's own name on the trigger. */
export const OTHER_FOLDER = "other folder";

/** The project the workspace holds, and the road to a folder beside it: the project's own name, or the chosen
 * folder's last segment once one is picked. A workspace is one project's copy, so the menu offers that project and
 * other folder, which hands the pick to the folder picker under the box. The button is capped at the row's width,
 * since a folder's name is as long as the person made it. */
function ProjectPicker({ workspaceId, projects, onOtherFolder }: { workspaceId: string; projects: readonly ProjectRef[]; onOtherFolder: () => void }) {
  const project = useDefaultProject(workspaceId);
  const chosen = useChosenFolder(workspaceId);
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
            follow(workspaceId, picked.path);
          }}
        >
          {projects.map(p => (
            <MenuRadioItem key={p.name} value={p.name} data-composer-project={p.name} title={p.path}>
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
  onPickAccess: (mode: string) => void;
  /** Opens the folder picker under the box, where the project menu's other folder row sends the pick. */
  onOtherFolder: () => void;
}) {
  useMachineCatalogs(workspaceId);
  const pick = useComposerOptionsStore(s => s.pick);
  const catalogs = useHarnessCatalogs(workspaceId);
  const project = useProject(workspaceId);
  const projects = useMemo(() => (project === null ? [] : [project]), [project]);
  const where = useWhereWord(workspaceId);
  const { catalog, model, picks, pinned, offerAgents } = useComposerPicks(workspaceId, thread);
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
        where={where}
        offerAgents={offerAgents}
        onPickHarness={harness => pick(workspaceId, "harness", harness)}
        onPickModel={(harness, value) => {
          if (harness !== catalog.harness) pick(workspaceId, "harness", harness);
          pick(workspaceId, "model", value, thread.threadKey);
        }}
      />
      {efforts.length > 0 || contextWindows.length > 0 || catalog.permissionModes.length > 0 ? (
        <DefaultsPicker
          workspaceId={workspaceId}
          threadKey={thread.threadKey}
          efforts={efforts}
          contextWindows={contextWindows}
          modes={catalog.permissionModes}
          picks={picks}
          note={thread.view.running ? accessReachLine(movesRunningAccess(catalog)) : null}
          onPickAccess={onPickAccess}
        />
      ) : null}
      {projects.length > 0 && canPickFolder(thread) ? <ProjectPicker workspaceId={workspaceId} projects={projects} onOtherFolder={onOtherFolder} /> : null}
    </>
  );
}
