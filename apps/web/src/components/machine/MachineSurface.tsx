// SPDX-License-Identifier: AGPL-3.0-only
// The machine surface of the right panel: facts, the projects on the machine
// with the import and the snapshot that images them, live utilisation, spend,
// the image's versions with rollback, pause, wake, resize, rebuild and forget
// for one workspace's machine. Pause, wake, rebuild, forget, import and copy
// id read the workspace registry; the tab keeps its own confirmations for the two
// that ask. A button is offered only where its verb can run and its
// capability is there; the panel ends where its content ends, with no
// sentence explaining what is not on it.
import { CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { runAction } from "../../actions/contextMenu.js";
import { CLIENT_CANNOT_REBUILD } from "../../actions/format.js";
import { actionById, resolveActions, rowLabelOf } from "../../actions/registry.js";
import { useWorkspaceVerbs } from "../../actions/verbs.js";
import { workspaceActions, workspaceTarget } from "../../actions/workspaceActions.js";
import { FREE_WORD, IMAGE_ALREADY_NEWEST, IMAGE_MOVE_CONFIRM, LINEAGE_MARKS, NOT_ON_THIS_KIND, agentsLine, behindGoldenLine, biggerSizeLine, diskTone, fmtBytes, fmtBytesOfTotal, fmtRate, fmtSize, fmtUptime, foldThreads, goldenForkName, goldenImage, imageKeptLine, imageMoveRefusal, isBilling, kindWords, missingToolRow, needsRebuild, outOfMemoryLine, plural, resizesMachines, servesReading, sizeWord, vaultStaleLine, wakeAskingAgainLine, workspaceKind, workspacePlace, workspaceProjects, workspaceState, workspaceStateOf, workspaceWord, type GoldenLeftBehind, type GoldenMissingTool, type GoldenRetired, type GoldenVersion, type LineageMark, type ProjectGolden, type SizeTone, type SnapshotLineage, type SysSample, type MachineSizeOffer, type WorkspaceCostEvent, type WorkspaceKindWords, type WorkspaceSize, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { isDesktopShell } from "../../lib/desktopShell.js";
import { cn, errorText } from "../../lib/utils.js";
import { LIVE_WINDOW, staleWord, useOutOfMemoryReading, useWorkspaceLive, type StaleWord } from "../../machine/live.js";
import { upgradeOptions, useCostSeries, useUpgrade, type Upgrade } from "../../protocol/machine.js";
import { useAbsentComputer, useCapabilities, useCost, usePlaces, useProtocolEvents, useStatus, useStore, useWorkspace } from "../../protocol/store.js";
import { DaemonDown } from "../DaemonDown.js";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog.js";
import { Button, WARN_BUTTON } from "../ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty.js";
import { ForgetWorkspaceDialog } from "../ForgetWorkspaceDialog.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { idleLabel, money, percentLabel } from "./format.js";
import { TONE_TEXT } from "../../lib/tone.js";
import { THIS_COMPUTER_WORD } from "../../settings/places.js";
import { whereRuns } from "../../sidebar/workspaceRows.js";
import { workspaceKindGlyph } from "../../workspaceKindGlyph.js";
import { SnapshotStorageLine } from "./SnapshotStorageLine.js";
import { UsageChart, UsageRangeToggle } from "./UsageChart.js";
import type { UsageRange } from "./usage.js";

export function MachineSurface({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const series = useCostSeries(workspaceId);
  if (!workspace) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>No workspace selected.</EmptyTitle>
          <EmptyDescription>Pick a workspace in the sidebar to see it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <Surface key={workspace.id} workspace={workspace} series={series} />;
}

function Surface({ workspace, series }: { workspace: WorkspaceView; series: WorkspaceCostEvent[] }) {
  const status = useStatus(workspace.id);
  const upgrade = useUpgrade(workspace.id);
  const pendingSize = upgrade.phase.kind === "resizing" || upgrade.phase.kind === "settling" ? upgrade.phase.size : null;
  // A machine wsp neither forks nor pays for has no spend to chart, nothing to nap and no image behind it; its rows
  // say what it is instead.
  const kind = kindWords(workspaceKind(workspace));
  const goldens = useProjectGoldens(kind.driven);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header workspace={workspace} status={status} />
      <ScrollArea className="min-h-0 flex-1">
        <Facts workspace={workspace} status={status} pendingSize={pendingSize} kind={kind} />
        <Projects workspace={workspace} status={status} kind={kind} onTaken={goldens.add} />
        <Live workspace={workspace} />
        {kind.driven && <Usage workspace={workspace} status={status} series={series} />}
        {kind.driven && <GoldenLineage workspace={workspace} projects={goldens.list} />}
      </ScrollArea>
      <Actions workspace={workspace} status={status} upgrade={upgrade} />
    </div>
  );
}

/** Every row of the pane, header and foot included: 12 px at the left and 20 px at the right, so the 6 px scroll
 * bar rides in the outer 8 px and never covers a value. The hairlines run edge to edge, being the row's own. */
const PANE_INSET = "pl-3 pr-5";

function Header({ workspace, status }: { workspace: WorkspaceView; status: WorkspaceStatus | null }) {
  const machineId = status?.machineId ?? workspace.machineId;
  const verbs = useWorkspaceVerbs();
  const places = usePlaces();
  const copy = actionById(resolveActions(workspaceActions, workspaceTarget(workspace, status, places), verbs, false), "copy-id");
  // On a joined computer the machine is the link, so the id is this host's own row key rather than anything a
  // provider would look up: the corner holds nothing there, and the Where row names the computer instead.
  const shown = workspacePlace({ machineId }) === undefined ? machineId : null;
  return (
    <div className={cn("flex items-center gap-2 border-b border-border/60 py-2", PANE_INSET)}>
      <MachineLead workspace={workspace} />
      <span className="min-w-0 truncate text-sm font-medium">{workspace.name}</span>
      {shown !== null && (
        <span className="ml-auto flex min-w-0 items-center gap-0.5 font-mono text-[.7rem] text-muted-foreground">
          <span className="max-w-28 truncate" title={shown} data-k="machine-id">
            {shown}
          </span>
          <Button size="icon-micro" variant="ghost-muted" aria-label={copy.title} onClick={() => void runAction(copy)}>
            <CopyIcon />
          </Button>
        </span>
      )}
    </div>
  );
}

/** The header's lead: the kind's own glyph, as the row wears it. The state is a word in the facts, never a hue here. */
function MachineLead({ workspace }: { workspace: WorkspaceView }) {
  const KindGlyph = workspaceKindGlyph(workspaceKind(workspace));
  return <KindGlyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />;
}

function Section({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={cn("border-b border-border/50 py-2.5 last:border-b-0", PANE_INSET)}>
      <div className="flex items-baseline gap-2 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {aside !== undefined && <span className="ml-auto font-mono normal-case tracking-normal text-muted-foreground/80">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A fact with its value flush right; a value the row cannot hold is cut with an ellipsis and the full text rides its title. */
function Row({ label, k, title, children }: { label: string; k: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono tabular-nums text-foreground" title={title ?? (typeof children === "string" ? children : undefined)} data-k={k}>
        {children}
      </span>
    </div>
  );
}

interface FactsProps {
  workspace: WorkspaceView;
  status: WorkspaceStatus | null;
  /** Painted while a resize is in flight, before a status carries the new size. */
  pendingSize: WorkspaceSize | null;
  kind: WorkspaceKindWords;
}

/** State and size for every machine; the nap for one wsp drives; for one that already existed, what it costs
 * (nothing), the system it runs, how long it has been up and the folder its commands start in. */
function Facts({ workspace, status, pendingSize, kind }: FactsProps) {
  const capabilities = useCapabilities();
  const places = usePlaces();
  const now = useClock(status?.idleAt !== undefined);
  const zombie = status?.reach.state === "zombie";
  const absent = useAbsentComputer(workspace.id, now);
  // Reach is not a row of its own: the protocol folds a machine that stopped answering into the state word, which
  // is the word every other surface shows for it.
  const state = workspaceStateOf(workspace, status);
  const stateWord = workspaceWord(state);
  const rebuild = needsRebuild({ phase: workspace.phase, machineState: status?.machineState, reach: status?.reach.state, wakeRefused: workspace.wakeRefused });
  // The full reading of the ask the host is on; the sidebar row reads the same two numbers in the words its slot holds.
  const wakeAskLine = status?.wakeAsk === undefined ? null : wakeAskingAgainLine(status.wakeAsk.ask, status.wakeAsk.of);
  const billing = isBilling(state);
  const outOfMemory = useOutOfMemoryReading(workspace.id, workspace.phase);
  const facts = status?.facts;
  const vault = status ?? workspace;
  const vaultStale = vaultStaleLine(vault);
  // The whole sentence, where the row above shows its first clause: the instruction is at the end of it, and this
  // is the surface with room for the command a person types on their own machine.
  const daemonLacks = (status ?? workspace).daemonRefusedAt?.why;
  const where = whereRuns(places, { workspace, status });
  return (
    <Section label="Workspace">
      <div className="mt-1 divide-y divide-border/40">
        <Row label="State" k="state" title={absent?.sentence ?? stateWord}>
          <span className={cn(zombie && "text-destructive-foreground")}>{absent?.word ?? stateWord}</span>
        </Row>
        <Row label="Where" k="where" title={where}>
          {where}
        </Row>
        <Row label="Size" k="size" title={pendingSize ? `${fmtSize(pendingSize)} · resizing` : status ? fmtSize(status.size, kind.cpu) : "pending"}>
          {pendingSize ? (
            <>
              {fmtSize(pendingSize)}
              <span className="text-muted-foreground"> · resizing</span>
            </>
          ) : status ? (
            fmtSize(status.size, kind.cpu)
          ) : (
            "pending"
          )}
        </Row>
        {kind.driven ? (
          <>
            <Row label="Auto-nap" k="idle">
              {idleLabel(billing ? status?.idleAt : undefined, now, state)}
            </Row>
          </>
        ) : (
          <>
            <Row label="Cost" k="cost">
              {FREE_WORD}
            </Row>
            {/* The system, the uptime and the folder are read over the daemon, so while the one this host started
                is not running there is nothing coming and three rows reading pending are three rows waiting on
                nothing. A computer this host only waits for keeps them: what it last reported is what is known
                about it, and dropping the rows would take that away on top of the silence. */}
            {absent?.start === undefined ? (
              <>
                <Row label="OS" k="os">
                  {facts?.os ?? "pending"}
                </Row>
                <Row label="Uptime" k="uptime">
                  {facts === undefined ? "pending" : fmtUptime(facts.uptimeMs)}
                </Row>
                <Row label="Folder" k="folder">
                  {facts?.folder ?? "pending"}
                </Row>
              </>
            ) : null}
          </>
        )}
        {vaultStale !== null && (
          <Row label="Backup" k="vault" title={vaultStale}>
            <span className="text-muted-foreground">{vaultStale}</span>
          </Row>
        )}
        {workspace.agents?.spawn === true && (
          <Row label="Agents" k="agents" title={agentsLine(workspace.agents)}>
            {agentsLine(workspace.agents)}
          </Row>
        )}
      </div>
      {wakeAskLine !== null && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" data-k="wake-ask">
          {wakeAskLine}
        </p>
      )}
      {status?.reason && (
        <p className={cn("mt-1.5 text-[11px] leading-relaxed", zombie ? "text-destructive-foreground" : "text-muted-foreground")} data-k="reason">
          {status.reason}
        </p>
      )}
      {vaultStale !== null && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" data-k="vault-refused">
          {vault.vaultRefused}
        </p>
      )}
      {daemonLacks !== undefined && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" data-k="daemon-refused">
          {daemonLacks}
        </p>
      )}
      {outOfMemory && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" data-k="out-of-memory">
          {outOfMemoryLine(outOfMemory)}
        </p>
      )}
      {outOfMemory && status && capabilities && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" data-k="bigger-size">
          {biggerSizeLine(status.size, capabilities.sizes)}
        </p>
      )}
      {rebuild && <Rebuild workspace={workspace} status={status} />}
    </Section>
  );
}

/** Every project image this host took, read once for the tab: the Versions section lists them under their versions and the
 * projects section adds the one it takes, so the two never read two lists. Read only where the versions draw, since a
 * machine with no image behind it neither lists images nor takes one. */
function useProjectGoldens(wanted: boolean): { list: ProjectGolden[]; add: (taken: ProjectGolden) => void } {
  const api = useStore(s => s.api);
  const [list, setList] = useState<ProjectGolden[]>([]);
  useEffect(() => {
    if (!api || !wanted) return () => {};
    let current = true;
    api.listProjectGoldens?.().then(
      p => {
        if (current) setList(p);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [api, wanted]);
  return { list, add: taken => setList(p => [...p, taken]) };
}

/** The projects on the machine, oldest import first, one mono row each: the name, the folder it landed at, its size
 * where the import measured one and the day it landed. Under them the two roads that change the list: the import
 * the row's menu offers, through the registry so it is refused where that is, and the snapshot that images the disk
 * with every project on it, offered only where the Versions section draws: a machine with an image behind it. */
function Projects({ workspace, status, kind, onTaken }: { workspace: WorkspaceView; status: WorkspaceStatus | null; kind: WorkspaceKindWords; onTaken: (taken: ProjectGolden) => void }) {
  const api = useStore(s => s.api);
  const verbs = useWorkspaceVerbs();
  const places = usePlaces();
  const projects = workspaceProjects(workspace);
  const importAction = actionById(resolveActions(workspaceActions, workspaceTarget(workspace, status, places), verbs, false), "import-project");
  const images = kind.driven && api?.snapshotWorkspace !== undefined;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const snapshot = async (): Promise<void> => {
    if (!api?.snapshotWorkspace) return;
    setBusy(true);
    try {
      const taken = await api.snapshotWorkspace(workspace.id);
      onTaken(taken);
      setNote(`Image of ${taken.projects.map(p => p.name).join(", ")} taken. New workspaces from it start with the projects in place.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section label="Projects" aside={projects.length > 0 ? plural(projects.length, "project") : undefined}>
      {projects.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground" data-k="projects-none">
          {isDesktopShell() ? "No projects yet. Import a folder, or drop one on the workspace's row." : "No projects yet. Import a folder."}
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-border/40">
          {projects.map(p => (
            <li key={p.dest} data-k={`project-${p.name}`} className="grid h-7 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_4.5rem_5.5rem] items-center gap-3 font-mono text-xs tabular-nums">
              <span data-cell="name" className="truncate text-foreground" title={p.name}>
                {p.name}
              </span>
              <span data-cell="folder" className="truncate text-muted-foreground" title={p.dest}>
                {p.dest}
              </span>
              <span data-cell="size" className="text-right text-muted-foreground">
                {p.size === undefined ? "" : fmtBytes(p.size)}
              </span>
              <span data-cell="imported" className="text-right text-muted-foreground">
                {p.importedAt.slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="xs" variant="outline" disabled={importAction.refusal !== null} title={importAction.refusal ?? importAction.hint ?? undefined} onClick={() => void runAction(importAction)}>
          Import a folder
        </Button>
        {images && (
          <Button size="xs" variant="outline" disabled={busy || projects.length === 0 || workspace.phase !== "running"} aria-label={`snapshot ${workspace.name} as an image`} onClick={() => void snapshot()}>
            Snapshot as image
          </Button>
        )}
      </div>
      <p className="mt-1 min-h-4 text-[11px] text-muted-foreground" data-k="projects-note">
        {busy ? "Taking the snapshot…" : (note ?? importWord(kind))}
      </p>
    </Section>
  );
}

/** What the import road on this kind does to the folder, as the note under the buttons: on this computer nothing
 * is carried, and a person about to import a 4 GB repo is owed that before they press it. Read off the kind's own
 * import road, so a kind that copies says nothing here and the road is never compared by kind. */
function importWord(kind: WorkspaceKindWords): string | null {
  return kind.imports === "registers" ? `On ${THIS_COMPUTER_WORD} a folder is registered where it is, not copied.` : null;
}

/** Re-renders once a second while a countdown is showing. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function Rebuild({ workspace, status }: { workspace: WorkspaceView; status: WorkspaceStatus | null }) {
  const api = useStore(s => s.api);
  const verbs = useWorkspaceVerbs();
  const places = usePlaces();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The tab asks before it rebuilds, so its registry entry opens the dialog; the dialog's own button calls the api and
  // names a client without the verb.
  const action = actionById(resolveActions(workspaceActions, workspaceTarget(workspace, status, places), { ...verbs, rebuild: async () => setOpen(true) }, false), "rebuild");

  const rebuild = async (): Promise<void> => {
    setOpen(false);
    if (!api?.rebuild) {
      setNote(CLIENT_CANNOT_REBUILD);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await api.rebuild(workspace.id);
      setNote("Workspace rebuilt from your image.");
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Button size="sm" variant="outline" className={WARN_BUTTON} disabled={busy || action.refusal !== null} title={action.refusal ?? action.hint ?? undefined} aria-label={rowLabelOf(action)} onClick={() => void runAction(action)}>
        {busy ? "Rebuilding…" : action.buttonWord}
      </Button>
      {note && (
        <p className="text-[11px] text-muted-foreground" data-k="rebuild-note">
          {note}
        </p>
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild {workspace.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              A fresh copy of your image replaces this workspace's computer and brings back what was saved before its last nap.
              The old one is stopped whatever it reports; anything running on it ends. Starting a new one costs a wake.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="outline" className={WARN_BUTTON} onClick={() => void rebuild()}>
              Rebuild
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}



/** cpu, memory and disk from the machine, one sparkline each. A napping workspace, or a running one whose link is
 * down, keeps the last values dim under the word for it; the daemon says nothing about a machine it is not on. A
 * daemon that refused the stream puts the word unavailable in the slots, and the runtime replaces a daemon too old
 * to serve them without anyone here asking: the machine's row says so while it does. A kind whose machines read no
 * metrics at all says so in the slots instead, rather than pending forever: no slot waits on a stream that will
 * never come. */
function Live({ workspace }: { workspace: WorkspaceView }) {
  const live = useWorkspaceLive(workspace.id);
  const absent = useAbsentComputer(workspace.id);
  const last = live.samples[live.samples.length - 1];
  const stale = staleWord(workspace.phase, live.reach === "live");
  // Nothing is sampling these rows while the daemon that reads them is not running, so the section says which part
  // is down and offers the start rather than printing unreachable three times about a computer on the desk.
  if (absent !== null && absent.start !== undefined) {
    return (
      <Section label="Live">
        <DaemonDown absent={absent} workspaceId={workspace.id} className="mt-1 flex flex-col items-start gap-2" />
      </Section>
    );
  }
  const kindWord = servesReading(workspaceKind(workspace), "metrics") ? null : NOT_ON_THIS_KIND;
  const share = (m: { used: number; total: number }): number => (m.total > 0 ? (m.used / m.total) * 100 : 0);
  const row = { kindWord, stale, unavailable: live.unavailable, samples: live.samples };
  return (
    <Section label="Live" aside={kindWord === null && last !== undefined && stale === null ? `load ${last.load1.toFixed(2)}` : undefined}>
      <div className="mt-1 divide-y divide-border/40">
        <LiveRow {...row} label="cpu" k="cpu" y={s => s.cpu} text={s => percentLabel(s.cpu)} tone={s => diskTone(s.cpu, 100)} />
        <LiveRow {...row} label="memory" k="mem" y={s => share(s.mem)} text={s => fmtBytesOfTotal(s.mem.used, s.mem.total)} tone={s => diskTone(s.mem.used, s.mem.total)} />
        <LiveRow {...row} label="disk" k="disk" y={s => share(s.disk)} text={s => fmtBytesOfTotal(s.disk.used, s.disk.total)} tone={s => diskTone(s.disk.used, s.disk.total)} />
      </div>
    </Section>
  );
}

/** The drawing box of one sparkline, stretched to the row; every value is a percent, so the scale is fixed. */
const SPARK_W = 100;
const SPARK_H = 16;
const SPARK_PAD = 1;

/** Sixty slots across the box with the newest sample in the last one, so a young series grows in from the right and a full one scrolls. */
function sparkPoints(samples: SysSample[], y: (s: SysSample) => number): { x: number; y: number }[] {
  const span = SPARK_H - 2 * SPARK_PAD;
  return samples.map((s, i) => ({
    x: ((LIVE_WINDOW - samples.length + i) / (LIVE_WINDOW - 1)) * SPARK_W,
    y: SPARK_PAD + (1 - Math.min(100, Math.max(0, y(s))) / 100) * span,
  }));
}

interface LiveRowProps {
  label: string;
  k: string;
  samples: SysSample[];
  y: (s: SysSample) => number;
  text: (s: SysSample) => string;
  /** The tone the sample's share earns, from the protocol's one percent table. */
  tone: (s: SysSample) => SizeTone;
  stale: StaleWord;
  /** The daemon's refusal of the stream; the slot reads unavailable and carries it as the title. */
  unavailable: string | null;
  /** The kind table's word for a kind that reads none of this, put in the slot as it is; null on a kind that reads
   * it, where the slot is a value's or a fault's to fill. */
  kindWord: string | null;
}

/** One fixed-height row: label, sparkline, value. The value slot has a fixed width so a word in place of a number
 * moves nothing; a single sample draws as a dot through the round cap. Hovering reads that sample into the slot. */
function LiveRow({ label, k, samples, y, text, tone, stale, unavailable, kindWord }: LiveRowProps) {
  const [hover, setHover] = useState<number | null>(null);
  const points = sparkPoints(samples, y);
  const shown = hover !== null ? samples[hover] : samples[samples.length - 1];
  const word = kindWord ?? stale ?? (unavailable !== null ? "unavailable" : shown === undefined ? "pending" : null);
  const ink = word === null && shown !== undefined ? TONE_TEXT[tone(shown)] : undefined;

  const track = (e: ReactMouseEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || samples.length === 0) return;
    const slot = Math.round(((e.clientX - box.left) / box.width) * (LIVE_WINDOW - 1));
    const at = slot - (LIVE_WINDOW - samples.length);
    setHover(at >= 0 && at < samples.length ? at : null);
  };

  return (
    <div
      className="grid h-7 grid-cols-[3.25rem_minmax(0,1fr)_10rem] items-center gap-2 text-xs"
      data-live-row={k}
      {...(kindWord === null && stale !== null ? { "data-stale": stale } : {})}
      {...(kindWord === null && unavailable !== null ? { "data-unavailable": unavailable } : {})}
      {...(kindWord !== null ? { "data-kind-word": kindWord } : {})}
    >
      <span className="text-muted-foreground">{label}</span>
      <svg className="block h-4 w-full" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" role="img" aria-label={`${label} over the last two minutes, one line`} onMouseMove={track} onMouseLeave={() => setHover(null)}>
        {points.length > 0 && (
          <path
            d={points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join("") + (points.length === 1 ? `L${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}` : "")}
            fill="none"
            className={stale !== null ? "stroke-muted-foreground/40" : "stroke-foreground/80"}
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            data-live-line
          />
        )}
        {hover !== null && points[hover] !== undefined && (
          <line x1={points[hover].x} x2={points[hover].x} y1={0} y2={SPARK_H} className="stroke-muted-foreground/50" strokeWidth={1} vectorEffect="non-scaling-stroke" data-live-hover />
        )}
      </svg>
      <span
        className={cn("truncate text-right font-mono tabular-nums", word !== null ? "text-muted-foreground/60" : ink)}
        data-k={k}
        {...(word === "unavailable" && unavailable !== null ? { title: unavailable } : {})}
      >
        {word ?? (shown !== undefined ? text(shown) : "")}
      </span>
    </div>
  );
}

function Usage({ workspace, status, series }: { workspace: WorkspaceView; status: WorkspaceStatus | null; series: WorkspaceCostEvent[] }) {
  const cost = useCost(workspace.id);
  const [range, setRange] = useState<UsageRange>("all");
  const billing = isBilling(workspaceStateOf(workspace, status));
  const rate = billing ? cost?.rateUsdPerHour ?? status?.rateUsdPerHour ?? 0 : 0;
  return (
    <Section label="Usage" aside={<UsageRangeToggle range={range} onChange={setRange} />}>
      <UsageChart series={series} range={range} />
      <div className="divide-y divide-border/40">
        <Row label="Rate now" k="rate">
          {`${money(rate, 3)}/hr`}
        </Row>
        <Row label="Accrued" k="accrued">
          {money(cost?.accruedUsd ?? 0)}
        </Row>
      </div>
      <SnapshotStorageLine />
    </Section>
  );
}

function GoldenLineage({ workspace, projects }: { workspace: WorkspaceView; projects: ProjectGolden[] }) {
  const api = useStore(s => s.api);
  const createWorkspace = useStore(s => s.createWorkspace);
  const applyWorkspace = useStore(s => s.applyWorkspace);
  const [lineage, setLineage] = useState<SnapshotLineage | null>(null);
  /** Version whose rollback awaits the confirm dialog. */
  const [armed, setArmed] = useState<GoldenVersion | null>(null);
  /** Version this workspace's move onto the head awaits the confirm dialog for. */
  const [moving, setMoving] = useState<number | null>(null);
  /** The action in flight, so the buttons wait for each other and the note names it. */
  const [busy, setBusy] = useState<"rollback" | "image" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  // The note is the last thing in a tab that scrolls, and after a move it is the only place that says which of the
  // person's own files did not follow the image, so it is brought into view instead of left below the fold.
  useEffect(() => {
    if (note !== null) noteRef.current?.scrollIntoView({ block: "nearest" });
  }, [note]);

  const load = useCallback(() => {
    if (!api) return () => {};
    let current = true;
    api.listSnapshots().then(
      l => {
        if (current) setLineage(l);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [api]);
  useEffect(load, [load]);
  // The manifest changes on the bus only when a golden seals (a rollback from
  // another client emits nothing), so that is the one stage worth a refetch.
  useProtocolEvents(
    useCallback(
      e => {
        if (e.type === "golden.stage" && e.stage === "sealed") load();
      },
      [load],
    ),
  );

  const rollback = async (version: number): Promise<void> => {
    if (!api) return;
    setArmed(null);
    setBusy("rollback");
    try {
      const result = await api.rollbackSnapshot(version);
      setLineage(result.lineage);
      setNote(`New workspaces use v${version}. Existing workspaces keep their image.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const updateImage = async (to: number): Promise<void> => {
    if (!api?.updateImage) return;
    setMoving(null);
    setBusy("image");
    try {
      const moved = await api.updateImage(workspace.id);
      applyWorkspace(moved.workspace);
      setNote(`${workspace.name} is on v${to}: ${moved.moved ? imageKeptLine(moved.kept, moved.fallback) : IMAGE_ALREADY_NEWEST}.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // A copy of a project image, named after the project it carries: the name is the row's title in the sidebar, so
  // it reads as what it is rather than as the verb underneath.
  const fork = (g: ProjectGolden): void => {
    void createWorkspace(`${goldenForkName(g)}-copy`, g.snapshotId);
  };

  const under = (snapshotId: string): ReactNode => <ProjectGoldens goldens={projects.filter(p => p.golden === snapshotId)} forkOf={workspace.golden} busy={busy !== null} onFork={fork} />;
  const versions = lineage ? [...lineage.versions].sort((a, b) => b.version - a.version) : [];
  // The head version, when this workspace is forked from an older one: what the offer moves it to.
  const onVersion = versions.find(v => v.snapshotId === workspace.golden);
  const behind = onVersion !== undefined && lineage?.head !== null && lineage?.head !== undefined && onVersion.version !== lineage.head ? lineage.head : null;
  // The runtime's rule, read here from the same facts, so the button is offered exactly when the move would be
  // taken: a project image, an image no golden knows, or a machine that is not running refuse it in both places.
  const moveRefusal = imageMoveRefusal(workspace.name, workspaceState({ phase: workspace.phase }), {
    knownVersion: onVersion !== undefined,
    projectImage: projects.some(p => p.snapshotId === workspace.golden),
  });
  const offered = api?.updateImage !== undefined;
  return (
    <Section label="Versions" aside={lineage?.head !== null && lineage?.head !== undefined ? `newest v${lineage.head}` : undefined}>
      <ul className={cn("mt-1 divide-y divide-border/40", LINEAGE_GRID)}>
        <LineageRow
          dot={workspace.phase === "running" ? "bg-success" : "border border-muted-foreground/60"}
          title={<span className="font-medium">Live disk</span>}
          detail={`created ${workspace.createdAt.slice(0, 10)}`}
          marks={["now"]}
        />
        {versions.length === 0 ? (
          <LineageRow
            dot="bg-muted-foreground/60"
            title={
              <span className="truncate font-mono" data-k="golden">
                Image
              </span>
            }
            detail="the image this workspace started from"
            below={under(workspace.golden)}
          />
        ) : (
          versions.map(v => {
            const head = v.version === lineage?.head;
            const fork = v.snapshotId === workspace.golden;
            return (
              <LineageRow
                key={v.version}
                dot={head ? "bg-foreground" : "bg-muted-foreground/60"}
                title={
                  <span className="font-mono" data-k={`v${v.version}`}>
                    v{v.version}
                  </span>
                }
                detail={`built ${v.createdAt.slice(0, 10)}${fork && behind !== null ? ` · ${behindGoldenLine(v.version, behind)}` : ""}`}
                marks={[...(head ? ["head" as const] : []), ...(fork ? ["fork" as const] : []), ...goldenImage(v).marks]}
                below={
                  <>
                    {fork && v.missingTools !== undefined && v.missingTools.length > 0 && <MissingTools tools={v.missingTools} />}
                    {fork && v.leftBehind !== undefined && v.leftBehind.length > 0 && <LeftBehind rows={v.leftBehind} />}
                    {fork && v.retired !== undefined && v.retired.length > 0 && <RetiredRows rows={v.retired} />}
                    {fork && v.silenced !== undefined && v.silenced.length > 0 && <LineageNote k="silenced" label="silenced in the shell" text={v.silenced.join(", ")} />}
                    {fork && v.shellNoise !== undefined && <LineageNote k="shell-noise" label="shell noise" text={v.shellNoise} />}
                    {under(v.snapshotId)}
                  </>
                }
                aside={
                  // Two different actions on one row: Update moves this workspace onto the head, Roll back moves the
                  // golden's head for every fork after it. Neither stands in for the other.
                  <>
                    {fork && behind !== null && offered && (
                      <Button size="xs" variant="outline" disabled={busy !== null || moveRefusal !== null} aria-label={`update ${workspace.name} to v${behind}`} onClick={() => setMoving(behind)}>
                        Update
                      </Button>
                    )}
                    {!head && (
                      <Button size="xs" variant="outline" disabled={busy !== null} aria-label={`roll back to v${v.version}`} onClick={() => setArmed(v)}>
                        Roll back
                      </Button>
                    )}
                  </>
                }
              />
            );
          })
        )}
      </ul>
      <p ref={noteRef} className="min-h-4 text-[11px] text-muted-foreground" data-k="lineage-note">
        {busy === "rollback" ? "Rolling back…" : busy === "image" ? "Moving to the newer image…" : (note ?? (behind !== null && moveRefusal !== null ? moveRefusal : null))}
      </p>
      <AlertDialog open={moving !== null} onOpenChange={open => !open && setMoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Move {workspace.name} to v{moving}?</AlertDialogTitle>
            <AlertDialogDescription>{IMAGE_MOVE_CONFIRM}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => moving !== null && void updateImage(moving)}>Move</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={armed !== null} onOpenChange={open => !open && setArmed(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to v{armed?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              New workspaces use v{armed?.version}; the newest moves from v{lineage?.head} to v{armed?.version}. Workspaces already
              made keep their image.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => armed && void rollback(armed.version)}>Roll back</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Section>
  );
}

/** The version list's columns: dot, title, marks, buttons. The list owns the grid and every row, nested lists included,
 * is a subgrid of it, so the marks sit in one column and the buttons in the next across the whole section. */
const LINEAGE_GRID = "grid grid-cols-[0.375rem_minmax(0,1fr)_auto_auto] gap-x-2";
const LINEAGE_SUBGRID = "col-span-4 grid grid-cols-subgrid";

/** One row of the version grid at a button's height, so a wrapping detail or an appearing button moves nothing; a
 * nested row keeps the columns and indents its dot and title. */
function LineageRow({ dot, title, detail, marks = [], aside, below, nested = false }: { dot: string; title: ReactNode; detail: string; marks?: readonly LineageMark[]; aside?: ReactNode; below?: ReactNode; nested?: boolean }) {
  return (
    <li className={cn(LINEAGE_SUBGRID, "items-center gap-y-0.5 py-1.5 text-xs")}>
      <span aria-hidden className={cn("size-1.5 rounded-full", dot, nested && "ml-3.5")} />
      <span className={cn("flex min-w-0 items-center", nested && "pl-3.5")}>{title}</span>
      <span className="flex min-h-6 items-center gap-2 text-[11px]">
        {marks.map(m => (
          <Mark key={m} kind={m} />
        ))}
      </span>
      <span className="flex min-h-6 items-center gap-1.5 text-[11px]">{aside}</span>
      <span className="col-span-3 col-start-2 text-[11px] text-muted-foreground">{detail}</span>
      {below !== undefined && <div className={cn(LINEAGE_SUBGRID, "[&>*]:col-span-4")}>{below}</div>}
    </li>
  );
}

/** One state word on a version row, muted mono like the row's other metadata: a state is text there, never a badge. */
function Mark({ kind }: { kind: LineageMark }) {
  return (
    <span className="font-mono text-muted-foreground" data-mark={kind}>
      {LINEAGE_MARKS[kind]}
    </span>
  );
}

/** The project images taken on forks of one version, newest first: the version's disk plus every project as it stood,
 * each a copy away from a task with no upload. */
function ProjectGoldens({ goldens, forkOf, busy, onFork }: { goldens: ProjectGolden[]; forkOf: string; busy: boolean; onFork: (g: ProjectGolden) => void }) {
  if (goldens.length === 0) return null;
  const rows = [...goldens].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <ul className={cn(LINEAGE_SUBGRID, "mt-1 divide-y divide-border/40")} aria-label="project images">
      {rows.map(g => (
        <LineageRow
          key={g.snapshotId}
          nested
          dot="border border-muted-foreground/60"
          title={
            <span className="truncate font-mono" data-k={`pg-${g.snapshotId}`}>
              {g.projects.map(p => p.name).join(", ")}
            </span>
          }
          detail={`snapshot ${g.createdAt.slice(0, 10)} · imported ${g.projects.at(-1)?.importedAt.slice(0, 10) ?? "never"} · from ${g.workspaceName}`}
          marks={g.snapshotId === forkOf ? ["fork"] : []}
          aside={
            <Button size="xs" variant="outline" disabled={busy} aria-label={`new workspace from the image of ${goldenForkName(g)} taken on ${g.workspaceName}, v${g.version}`} onClick={() => onFork(g)}>
              New workspace
            </Button>
          }
        />
      ))}
    </ul>
  );
}

/** A list under one version row, behind a micro-label: what the version is missing, what it left behind, what it
 * retired. One wrapper so they read as one thing and only their rows differ. */
function UnderVersion({ label, k, children }: { label: string; k: string; children: ReactNode }) {
  return (
    <div className="mt-1.5 ml-3.5" data-k={k}>
      <p className="text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** Rows of name, note and state under a version, the states in one column; `keys` are the data-k of the list, the
 * name and the note. */
function VersionNotes({ label, aria, keys, rows }: { label: string; aria: string; keys: [string, string, string]; rows: { key: string; name: string; note?: string; mark?: LineageMark }[] }) {
  return (
    <UnderVersion label={label} k={keys[0]}>
      <ul className="mt-0.5 grid grid-cols-[fit-content(7rem)_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-muted-foreground" aria-label={aria}>
        {rows.map(r => (
          <li key={r.key} className="contents">
            <span className="min-w-0 break-words" data-k={keys[1]}>
              {r.name}
            </span>
            <span className="min-w-0 break-words" data-k={keys[2]}>
              {r.note}
            </span>
            <span>{r.mark !== undefined && <Mark kind={r.mark} />}</span>
          </li>
        ))}
      </ul>
    </UnderVersion>
  );
}

/** What a version's image carries that its recipe no longer asks for: an update leaves the bytes where they are, so
 * a fork still has them and nothing says they are missing. */
function RetiredRows({ rows }: { rows: GoldenRetired[] }) {
  return <VersionNotes label="retired, still on this image" aria="rows retired from this image" keys={["retired-rows", "retired-row", "retired-note"]} rows={rows.map(r => ({ key: r.id, name: r.name }))} />;
}

/** One row per tool the import left off the image, the reason beside its name and the outcome as its mark: a count
 * would not say why a tool is missing. */
function MissingTools({ tools }: { tools: GoldenMissingTool[] }) {
  return <VersionNotes label="not on this image" aria="tools not on this image" keys={["missing-tools", "missing-tool", "missing-note"]} rows={tools.map(t => ({ key: t.id, ...missingToolRow(t) }))} />;
}

/** One row per path the pack left off the image, the file it was read from beside the reason. */
function LeftBehind({ rows }: { rows: GoldenLeftBehind[] }) {
  return <VersionNotes label="left on this computer" aria="left on this computer" keys={["left-behind", "left-path", "left-note"]} rows={rows.map(r => ({ key: `${r.path} ${r.note}`, name: r.path, note: r.note }))} />;
}

/** One line under a version about its shell: the rc calls the pack silenced, or what the shell printed on its first start, so a command that does nothing or a line before the prompt has its reason here. */
function LineageNote({ k, label, text }: { k: string; label: string; text: string }) {
  return (
    <p className="mt-1.5 ml-3.5 text-[11px] text-muted-foreground" data-k={k}>
      <span className="text-[.65rem] font-medium uppercase tracking-wider">{label}</span> <span className="font-mono">{text}</span>
    </p>
  );
}

/** Pause or wake, resize and forget, for a machine wsp drives; a machine that already existed takes none of them, so
 * the tab ends at its facts. Each button is offered only while its verb can run: Pause while the machine bills, Wake
 * while it is paused, nothing while it moves between the two; Resize only on a provider that resizes and only while a
 * bigger size is on offer; Forget once the machine is gone. */
function Actions({ workspace, status, upgrade }: { workspace: WorkspaceView; status: WorkspaceStatus | null; upgrade: Upgrade }) {
  const verbs = useWorkspaceVerbs();
  const capabilities = useCapabilities();
  const places = usePlaces();
  const sessions = useStore(s => s.sessions[workspace.id]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<MachineSizeOffer | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const gone = workspace.phase === "gone";
  // The tab's forget opens its own dialog, in place of the request the sidebar answers; the dialog names a client without the verb.
  const actions = resolveActions(workspaceActions, workspaceTarget(workspace, status, places), { ...verbs, forget: () => setForgetting(true) }, false);
  const phase = actionById(actions, "phase");
  const forget = actionById(actions, "forget");
  // Backend fact, not a probe: a provider with no road to a new size gets no picker and no button. The whole road
  // is read, the same reading the runtime's own gate makes, so nothing here offers a size the confirm would refuse.
  const options = status && capabilities !== null && resizesMachines(capabilities) ? upgradeOptions(status.size, capabilities.sizes) : [];
  const choice = picked ?? options[0] ?? null;
  const rate = status?.rateUsdPerHour ?? null;
  const driven = kindWords(workspaceKind(workspace)).driven;
  const offersResize = status !== null && !gone && options.length > 0;
  const note = upgrade.phase.kind === "resizing" ? "Resizing…" : upgrade.phase.kind === "settling" ? "Resized." : null;

  const close = (): void => {
    setOpen(false);
    setPicked(null);
  };
  const confirm = (): void => {
    if (!choice) return;
    close();
    upgrade.run({ cpu: choice.cpu, memMb: choice.memMb });
  };

  if (!driven) return null;
  const buttons = [
    gone ? (
      <Button
        key="forget"
        variant="outline"
        size="sm"
        className={cn("flex-1", WARN_BUTTON)}
        disabled={forget.refusal !== null}
        aria-label={rowLabelOf(forget)}
        title={forget.refusal ?? forget.hint ?? undefined}
        onClick={() => void runAction(forget)}
      >
        {forget.buttonWord}
      </Button>
    ) : phase.refusal === null ? (
      <Button key="phase" variant="outline" size="sm" className="flex-1" aria-label={rowLabelOf(phase)} title={phase.hint ?? undefined} onClick={() => void runAction(phase)}>
        {phase.buttonWord}
      </Button>
    ) : null,
    offersResize ? (
      <Button key="resize" size="sm" className="flex-1" disabled={upgrade.phase.kind === "resizing"} aria-label={`resize ${workspace.name}`} onClick={() => (open ? close() : setOpen(true))}>
        Resize
      </Button>
    ) : null,
  ].filter(button => button !== null);
  if (buttons.length === 0 && note === null && upgrade.phase.kind !== "failed") return null;
  return (
    <footer className={cn("flex flex-col gap-2 border-t border-border/60 py-3", PANE_INSET)}>
      {buttons.length > 0 && <div className="flex gap-2">{buttons}</div>}
      {open && status && choice && (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2.5">
          {options.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {options.map(o => (
                <Button
                  key={sizeWord(o)}
                  size="xs"
                  variant="outline"
                  aria-pressed={sizeWord(o) === sizeWord(choice)}
                  className={cn(sizeWord(o) === sizeWord(choice) && "border-foreground/60")}
                  onClick={() => setPicked(o)}
                >
                  {fmtSize(o)}
                </Button>
              ))}
            </div>
          )}
          <div className="divide-y divide-border/40">
            <Row label="Current" k="resize-from">
              {fmtSize(status.size)}
              {rate !== null ? ` · ${fmtRate(rate)}` : ""}
            </Row>
            <Row label="New" k="resize-to">
              {`${fmtSize(choice)} · ${fmtRate(choice.rateUsdPerHour)}`}
            </Row>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button size="xs" onClick={confirm}>
              Confirm resize
            </Button>
          </div>
        </div>
      )}
      {gone && <ForgetWorkspaceDialog workspace={workspace} threads={foldThreads(sessions ?? []).length} open={forgetting} onOpenChange={setForgetting} />}
      {(note !== null || upgrade.phase.kind === "failed") && (
        <p className="text-[11px] text-muted-foreground" role="status">
          {note}
          {upgrade.phase.kind === "failed" && (
            <button type="button" className="cursor-pointer text-left text-destructive-foreground" onClick={upgrade.dismiss}>
              {upgrade.phase.message}
            </button>
          )}
        </p>
      )}
    </footer>
  );
}
