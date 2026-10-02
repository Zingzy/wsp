// SPDX-License-Identifier: AGPL-3.0-only
// The model and effort pickers inside the composer box, and the access picker
// in the strip under it. Each lists
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
// than that beside the inline panel. A pick belongs to the
// draft it was made on and rides that draft's sessions.start, which takes it
// away, so the next draft opens on the defaults; a thread that has
// run keeps the agent and the access its own rows carry: the model, its
// window and the effort a pick made on such a thread still ride its next
// send, the agent and the access never do. The access pick is
// kept on the host's own record rather than in this browser, and on a thread that has
// run it goes through the access verb, the one road that changes a thread's
// access, so that thread's next turn runs at it; where the harness takes a
// mode change mid-turn it reaches the turn in front of the person too, the
// prompt it is stopped on included, and the menu says which of the two a pick
// will do while a turn runs, over the list, before the pick is made.
import { BrainIcon, ChevronDownIcon, CircleSlashIcon, HandIcon, LockIcon, LockOpenIcon, PenLineIcon, PencilRulerIcon, ShieldIcon, SparklesIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_AGENT } from "@wsp/catalog";
import { ACCESS_REFUSED_LINE, accessReachLine, contextWindowsFor, effortsFor, markedFor, movesRunningAccess, resolveThreadDefaults, type DefaultsAsk, type HarnessCatalog, type HarnessModel, type HarnessOption, type SessionView } from "@wsp/protocol";
import { projectHomeKey, projectOfKey, useHarnessCatalog, useHarnessCatalogs, useStore, useThreadSessions, useWorkspace } from "../../protocol/store";
import { useComputerName } from "../../sidebar/workspaceRows";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { useComposerDraftStore } from "./composerDraftStore";
import { togglePick, useMultiPicks, useMultiPickStore } from "./composerMultiPick";
import { useComposerOptions, useComposerOptionsStore, type ComposerOptionKey, type PickThreads } from "./composerOptionsStore";
import { effectivePicks, pickedFor, resolveModel, startOptionsFrom, threadPicks, type ComposerStart, type ResolvedPicks } from "./composerPicks";
import { ACCESS_WORD, accessLabel, REASONING_WORD, reasoningLabel } from "./format";
import type { ChatThreadHandle } from "./useChatThread";
import { ROW_ITEM_CLASS } from "./ComposerCheckoutRow";

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
  /** The pinned thread's latest own row, which an access pick between turns is put to through the access verb; null
   * on a thread that has not run, and on one whose rows fell off the runtime's cap. */
  readonly latestRow: SessionView | null;
}

/** What the one rule reads for a composer's next thread: the person's defaults and the overrides of the project its
 * send lands in. Read off the record the app holds, so a default changed in Settings reaches an open composer. */
function useDefaultsAsk(workspaceId: string): Pick<DefaultsAsk, "prefs" | "project"> {
  const projectId = useStore(s => projectOfKey(s, workspaceId));
  const defaultAgent = useStore(s => s.preferences.defaultAgent);
  const agentDefaults = useStore(s => s.preferences.agentDefaults);
  const project = useStore(s => (projectId === undefined ? undefined : s.preferences.projectDefaults[projectId]));
  return useMemo(() => ({ prefs: { ...(defaultAgent !== undefined ? { defaultAgent } : {}), agentDefaults }, ...(project !== undefined ? { project } : {}) }), [agentDefaults, defaultAgent, project]);
}

/** The composer's picks for a workspace, and the catalog they read from: the machine's once it answered, else the
 * table's. A thread that has run keeps its own agent; any other opens on the agent picked for this draft, else on
 * the one the defaults name, its lists marked with what the defaults pick, so the pickers show what the host starts. */
export function useComposerPicks(workspaceId: string, thread: ChatThreadHandle): ComposerPicks {
  const catalogs = useHarnessCatalogs(workspaceId);
  const ask = useDefaultsAsk(workspaceId);
  const kept = useComposerOptions(workspaceId);
  const rows = useThreadSessions(workspaceId, thread.threadKey);
  const pickedOn = useComposerOptionsStore(s => s.pickedOn[workspaceId] ?? NO_THREADS);
  const picked = useMemo(() => pickedFor(kept, thread.view, pickedOn, thread.threadKey), [kept, pickedOn, thread.threadKey, thread.view]);
  const onThread = useMemo(() => threadPicks(thread.view, rows), [rows, thread.view]);
  // The agent the open thread runs on, off its own record and then its own rows: a workspace's latest session is
  // as often another thread's.
  const own = thread.view.agent ?? rows.at(-1)?.harness;
  const pinned = own !== undefined && !thread.fresh && (thread.view.entries.length > 0 || thread.view.running);
  const latestRow = pinned ? rows.at(-1) ?? null : null;
  // The agent the host marks is its own answer with no project read, so the rule here falls back where the host's does.
  const fallback = catalogs.find(c => c.isDefault === true)?.harness ?? catalogs[0]?.harness ?? DEFAULT_AGENT.id;
  const harness = pinned ? own : picked.harness ?? resolveThreadDefaults({ firstAgent: fallback, catalogOf: id => catalogs.find(c => c.harness === id), ...ask }).agent.value;
  const listed = useHarnessCatalog(harness, workspaceId);
  const catalog = useMemo(() => (listed === null ? null : markedFor(listed, resolveThreadDefaults({ firstAgent: harness, named: harness, catalogOf: () => listed, ...ask }))), [ask, harness, listed]);
  const model = useMemo(() => (catalog === null ? null : resolveModel(catalog, { picked: picked.model, thread: onThread.model })), [catalog, picked.model, onThread.model]);
  const picks = useMemo(() => (catalog === null ? null : effectivePicks(catalog, { picked, thread: onThread })), [catalog, picked, onThread]);
  const startOptions = useMemo(() => (catalog === null ? {} : startOptionsFrom(catalog, picked, onThread)), [catalog, picked, onThread]);
  return { harness, catalog, model, picks, startOptions, pinned, latestRow };
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

const triggerClass = "h-8 shrink-0 gap-2 px-2 text-[15px] font-normal text-muted-foreground hover:text-foreground sm:h-8 sm:text-[15px] [&_svg]:mx-0";

function DefaultBadge() {
  return <span className="ms-2 text-xs leading-4 text-muted-foreground">default</span>;
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
/** Fast, where the model in front of the person offers it: the thread's own, and held for a composer whose thread
 * does not exist yet. */
export interface FastPick {
  readonly on: boolean;
  readonly set: (on: boolean) => void;
  readonly held: boolean;
}

export const FAST_WORDS = {
  group: "Fast mode",
  on: "On",
  off: "Off",
  note: "The same model answering sooner, billed at its fast rate.",
  normal: "Normal",
  fast: "Fast",
  bolt: "Fast mode on",
} as const;

/** The reasoning effort, the context window and Fast, one menu, as T3 Code's traits picker: how hard, how far and how
 * fast the model reads. The button wears a bolt while Fast is on and nothing of it while off. */
function ReasoningPicker({
  workspaceId,
  /** The thread an effort or a window pick belongs to: each is something the thread already runs at, so a pick here
   * is a change to this thread and not to every thread of the workspace. */
  threadKey,
  efforts,
  contextWindows,
  picks,
  fast,
}: {
  workspaceId: string;
  threadKey: string;
  efforts: HarnessOption[];
  contextWindows: HarnessOption[];
  picks: ResolvedPicks;
  fast: FastPick | null;
}) {
  const pick = useComposerOptionsStore(s => s.pick);
  const reads = efforts.length > 0 || contextWindows.length > 0;
  // A menu that holds Fast alone says which it is in words, since a bare bolt or nothing would say nothing.
  const label = reads ? reasoningLabel(efforts.find(o => o.value === picks.effort), contextWindows.find(o => o.value === picks.contextWindow)) : fast?.on === true ? FAST_WORDS.fast : FAST_WORDS.normal;
  const onPick = (key: ComposerOptionKey) => (next: unknown) => {
    if (typeof next === "string") pick(workspaceId, key, next, threadKey);
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={triggerClass}
        aria-label={`${REASONING_WORD}: ${label}`}
        data-composer-picker="reasoning"
        data-effort={picks.effort ?? undefined}
        data-context-window={picks.contextWindow ?? undefined}
      >
        {reads ? <BrainIcon className="size-4 shrink-0" aria-hidden /> : null}
        <span className="truncate">{label}</span>
        {fast?.on === true ? (
          <>
            <ZapIcon data-composer-fast-bolt className="size-3.5 shrink-0 fill-current opacity-80" aria-hidden />
            <span className="sr-only">{FAST_WORDS.bolt}</span>
          </>
        ) : null}
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
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
        {fast !== null && reads ? <MenuSeparator /> : null}
        {fast !== null ? (
          <MenuGroup>
            <MenuGroupLabel>{FAST_WORDS.group}</MenuGroupLabel>
            <MenuRadioGroup value={fast.on ? "on" : "off"} onValueChange={next => fast.set(next === "on")}>
              <MenuRadioItem value="on" data-composer-fast="on" disabled={fast.held} className="items-start py-1.5">
                <span className="flex min-w-0 flex-col">
                  <span>{FAST_WORDS.on}</span>
                  <span className="hidden text-xs leading-4 text-muted-foreground sm:block">{FAST_WORDS.note}</span>
                </span>
              </MenuRadioItem>
              <MenuRadioItem value="off" data-composer-fast="off" disabled={fast.held}>
                {FAST_WORDS.off}
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** What the agent may do without asking: its own menu, with what a pick does to a running turn over the list. A pick
 * the running turn refused stands on the button, in the refusal's ink with the sentence on its hover. */
function AccessPicker({
  modes,
  picks,
  refused,
  /** What a pick does to the turn running now, over the access list; nothing while no turn runs and the pick only starts one. */
  note,
  onPickAccess,
  inBar = false,
}: {
  modes: ReadonlyArray<HarnessOption>;
  picks: ResolvedPicks;
  refused: string | null;
  note: string | null;
  onPickAccess: (mode: string) => void;
  /** In the box beside the model and the effort, at their size, rather than in the strip under it. */
  inBar?: boolean;
}) {
  const shown = picks.permissionMode;
  const access = modes.find(o => o.value === shown);
  const label = accessLabel(access);
  const Icon = (shown !== null ? ACCESS_ICONS[shown] : undefined) ?? ShieldIcon;
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={cn(inBar ? triggerClass : cn(ROW_ITEM_CLASS, "hover:text-foreground"), refused !== null && "text-error-foreground hover:text-error-foreground")}
        aria-label={`${ACCESS_WORD}: ${label}`}
        data-composer-picker="access"
        data-access={shown ?? undefined}
        {...(refused !== null ? { "data-access-refused": refused, title: refused } : {})}
      >
        <Icon className={cn(inBar ? "size-4" : "size-3", "shrink-0")} aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDownIcon className={cn("shrink-0", inBar ? "size-3.5 opacity-60" : "size-3 opacity-50")} />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>Access</MenuGroupLabel>
          {note !== null ? <MenuGroupLabel data-composer-access-reach>{note}</MenuGroupLabel> : null}
          <MenuRadioGroup
            value={shown}
            onValueChange={next => {
              const mode = modes.find(o => o.value === next);
              if (mode !== undefined) onPickAccess(mode.value);
            }}
          >
            <OptionRows options={modes} />
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The hairline between two pickers of the bar, so each reads as its own control. */
export const BarRule = () => <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-border" />;

/** The thread an access pick is put to through the access verb, once it has run: the runtime's id for one of its
 * rows, which is what sessions.access takes, and the turn running now where one is, which the refusal note belongs
 * to; null on a thread that has not run, whose pick only decides what it opens at. */
export interface AccessTarget {
  readonly sessionId: string;
  readonly turnId: string | null;
}

/** The one road an access pick takes. It goes onto the host's record, where the next thread in this workspace reads
 * it whoever opens it, and, on a thread that has run, through the access verb, the one road that changes a thread's
 * access: the thread's next turn runs at it, and the turn in front of the person moves too where the harness's own
 * row says it takes a mode change mid-turn (`movesAccess`, which is what the menu says over its list before the
 * pick). `line` is the refusal that stands on the picker when a row saying so came back refused all the same:
 * nothing is said for a harness whose row already said the pick waits, since the person read that before they
 * picked, and nothing for a turn that simply ended. It stands only while the turn it is about is still the running
 * one. */
export function useAccessPick(workspaceId: string, target: AccessTarget | null, threadKey: string, movesRunningTurn: boolean): { pick: (mode: string) => void; line: string | null } {
  const api = useStore(s => s.api);
  const setPreferences = useStore(s => s.setPreferences);
  const stamp = useComposerOptionsStore(s => s.pick);
  const [note, setNote] = useState<{ turnId: string } | null>(null);
  const pick = useCallback(
    (mode: string) => {
      setNote(null);
      void setPreferences({ access: { [workspaceId]: mode } });
      // The thread it was picked on is kept in the browser beside the other picks, so the button paints this
      // thread's pick before the thread's row comes round with it, and not every thread here.
      stamp(workspaceId, "permissionMode", mode, threadKey);
      if (target === null || api?.setSessionAccess === undefined) return;
      const turnId = target.turnId;
      void api.setSessionAccess(target.sessionId, mode).then(outcome => {
        if (outcome === "unsupported" && movesRunningTurn && turnId !== null) setNote({ turnId });
      }, () => {});
    },
    [api, movesRunningTurn, setPreferences, stamp, target, threadKey, workspaceId],
  );
  return { pick, line: note !== null && note.turnId === target?.turnId ? ACCESS_REFUSED_LINE : null };
}

export function ComposerOptionPickers({
  workspaceId,
  thread,
  compact = false,
  fast = null,
}: {
  /** The one-line composer's pickers, with no rule between them. */
  compact?: boolean;
  workspaceId: string;
  thread: ChatThreadHandle;
  fast?: FastPick | null;
}) {
  useMachineCatalogs(workspaceId);
  const pick = useComposerOptionsStore(s => s.pick);
  const catalogs = useHarnessCatalogs(workspaceId);
  const where = useComputerName(workspaceId);
  const { catalog, model, picks, pinned } = useComposerPicks(workspaceId, thread);
  // Only a home's send opens a copy per model; a send anywhere else lands in the one thread on screen.
  const home = useStore(s => s.projects.some(p => projectHomeKey(p.id) === workspaceId));
  const added = useMultiPicks(workspaceId);
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
        onPickHarness={harness => pick(workspaceId, "harness", harness)}
        onPickModel={(harness, value) => {
          if (harness !== catalog.harness) pick(workspaceId, "harness", harness);
          pick(workspaceId, "model", value, thread.threadKey);
          useMultiPickStore.getState().set(workspaceId, []);
        }}
        {...(home
          ? {
              multi: {
                picks: added,
                onAdd: (harness: string, next: HarnessModel) =>
                  togglePick(workspaceId, model === null ? null : { harness: catalog.harness, model: model.value, label: model.label }, { harness, model: next.value, label: next.label }),
              },
            }
          : {})}
      />
      {efforts.length > 0 || contextWindows.length > 0 || fast !== null ? (
        <>
          {compact ? null : <BarRule />}
          <ReasoningPicker workspaceId={workspaceId} threadKey={thread.threadKey} efforts={efforts} contextWindows={contextWindows} picks={picks} fast={fast} />
        </>
      ) : null}
    </>
  );
}

/** The access picker, sized for the strip under the box, or for the box's own bar where it stands there. */
export function ComposerAccessPicker({ workspaceId, thread, onPickAccess, refused, inBar = false }: { workspaceId: string; thread: ChatThreadHandle; onPickAccess: (mode: string) => void; refused: string | null; inBar?: boolean }) {
  const { catalog, picks } = useComposerPicks(workspaceId, thread);
  if (catalog === null || picks === null || catalog.permissionModes.length === 0) return null;
  return (
    <AccessPicker
      modes={catalog.permissionModes}
      picks={picks}
      refused={refused}
      note={thread.view.running ? accessReachLine(movesRunningAccess(catalog)) : null}
      onPickAccess={onPickAccess}
      inBar={inBar}
    />
  );
}
