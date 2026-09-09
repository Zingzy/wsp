// SPDX-License-Identifier: AGPL-3.0-only
// The machine surface of the right panel: facts, the projects on the machine
// with the import and the snapshot that images them, live utilisation, spend,
// lineage with rollback, pause, wake, upgrade, rebuild and forget for one
// workspace's machine. Pause, wake, rebuild, forget, import and copy id read
// the workspace registry; the tab keeps its own confirmations for the two
// that ask. A button is offered only where its verb can run and its
// capability is there; the panel ends where its content ends, with no
// sentence explaining what is not on it.
import { CopyIcon } from "lucide-react";
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { runAction } from "../../actions/contextMenu.js";
import { CLIENT_CANNOT_REBUILD } from "../../actions/format.js";
import { actionById, resolveActions, rowLabelOf } from "../../actions/registry.js";
import { useWorkspaceVerbs } from "../../actions/verbs.js";
import { workspaceActions, workspaceTarget } from "../../actions/workspaceActions.js";
import { FREE_WORD, LINEAGE_MARKS, NOT_ON_THIS_KIND, behindGoldenLine, biggerSizeLine, fmtBytes, fmtRate, fmtSize, fmtUptime, foldThreads, goldenForkName, goldenImage, imageMoveRefusal, isBilling, kindWords, missingToolRow, needsRebuild, outOfMemoryLine, plural, sizeWord, workspaceKind, workspaceProjects, workspaceState, workspaceStateOf, type GoldenLeftBehind, type GoldenMissingTool, type GoldenRetired, type GoldenVersion, type LineageMark, type ProjectGolden, type SnapshotLineage, type SysSample, type MachineSizeOffer, type WorkspaceCostEvent, type WorkspaceKindWords, type WorkspaceSize, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { isDesktopShell } from "../../lib/desktopShell.js";
import { cn, errorText } from "../../lib/utils.js";
import { LIVE_WINDOW, useOutOfMemoryReading, useWorkspaceLive } from "../../machine/live.js";
import { upgradeOptions, useCostSeries, useUpgrade, type Upgrade } from "../../protocol/machine.js";
import { useCapabilities, useCost, useProtocolEvents, useStatus, useStore, useWorkspace } from "../../protocol/store.js";
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
import {
  bytesOfLabel,
  diskTier,
  divergentMachineState,
  durationLabel,
  idleLabel,
  money,
  percentLabel,
  phaseLabel,
  reachLabel,
  type DiskTier,
} from "./format.js";
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
          <EmptyDescription>Pick a workspace in the sidebar to see its machine.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <Surface key={workspace.id} workspace={workspace} series={series} />;
}

function Surface({ workspace, series }: { workspace: WorkspaceView; series: WorkspaceCostEvent[] }) {
  const status = useStatus(workspace.id);
  const upgrade = useUpgrade(workspace.id);
  const last = series[series.length - 1];
  const pendingSize = upgrade.phase.kind === "resizing" || upgrade.phase.kind === "settling" ? upgrade.phase.size : null;
  // A machine wsp neither forks nor pays for has no spend to chart, nothing to nap and no image behind it; its rows
  // say what it is instead.
  const kind = kindWords(workspaceKind(workspace));
  const goldens = useProjectGoldens(kind.machine === null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header workspace={workspace} status={status} />
      <ScrollArea className="min-h-0 flex-1">
        <Facts workspace={workspace} status={status} awakeMs={last ? last.awakeMs : null} pendingSize={pendingSize} kind={kind} />
        <Projects workspace={workspace} status={status} kind={kind} onTaken={goldens.add} />
        <Live workspace={workspace} kind={kind} />
        {kind.driven && <Usage workspace={workspace} status={status} series={series} />}
        {kind.machine === null && <GoldenLineage workspace={workspace} projects={goldens.list} />}
      </ScrollArea>
      <Actions workspace={workspace} status={status} upgrade={upgrade} />
    </div>
  );
}

function Header({ workspace, status }: { workspace: WorkspaceView; status: WorkspaceStatus | null }) {
  const machineId = status?.machineId ?? workspace.machineId;
  const verbs = useWorkspaceVerbs();
  const copy = actionById(resolveActions(workspaceActions, workspaceTarget(workspace, status), verbs, false), "copy-id");
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <MachineLead workspace={workspace} />
      <span className="min-w-0 truncate text-sm font-medium">{workspace.name}</span>
      <span className="ml-auto flex min-w-0 items-center gap-0.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="max-w-28 truncate" title={machineId} data-k="machine-id">
          {machineId}
        </span>
        <Button size="icon-micro" variant="ghost-muted" aria-label={copy.title} onClick={() => void runAction(copy)}>
          <CopyIcon />
        </Button>
      </span>
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
    <section className="border-b border-border/50 px-3 py-2.5 last:border-b-0">
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
  awakeMs: number | null;
  /** Painted while an upgrade is in flight, before a status carries the new size. */
  pendingSize: WorkspaceSize | null;
  kind: WorkspaceKindWords;
}

/** State, reach and size for every machine; awake time and the nap for one wsp drives; for one that already existed,
 * what it costs (nothing), the system it runs, how long it has been up and the folder its commands start in. */
function Facts({ workspace, status, awakeMs, pendingSize, kind }: FactsProps) {
  const capabilities = useCapabilities();
  const now = useClock(status?.idleAt !== undefined);
  const diverged = status ? divergentMachineState(workspace.phase, status.machineState) : null;
  const zombie = status?.reach.state === "zombie";
  const rebuild = needsRebuild({ phase: workspace.phase, machineState: status?.machineState, reach: status?.reach.state });
  const billing = isBilling(workspaceStateOf(workspace, status));
  const outOfMemory = useOutOfMemoryReading(workspace.id, workspace.phase);
  const facts = status?.facts;
  return (
    <Section label="Machine">
      <div className="mt-1 divide-y divide-border/40">
        <Row label="State" k="state" title={diverged ? `${phaseLabel(workspace.phase)} · machine ${diverged}` : phaseLabel(workspace.phase)}>
          {phaseLabel(workspace.phase)}
          {diverged && <span className="text-muted-foreground"> · machine {diverged}</span>}
        </Row>
        <Row label="Reach" k="reach" title={status ? reachLabel(status.reach.state, workspaceKind(workspace)) : "pending"}>
          {status ? (
            <span className={cn(zombie && "text-destructive-foreground")} data-reach={status.reach.state}>
              {reachLabel(status.reach.state, workspaceKind(workspace))}
            </span>
          ) : (
            "pending"
          )}
        </Row>
        <Row label="Size" k="size" title={pendingSize ? `${fmtSize(pendingSize)} · resizing` : status ? fmtSize(status.size) : "pending"}>
          {pendingSize ? (
            <>
              {fmtSize(pendingSize)}
              <span className="text-muted-foreground"> · resizing</span>
            </>
          ) : status ? (
            fmtSize(status.size)
          ) : (
            "pending"
          )}
        </Row>
        {kind.driven ? (
          <>
            <Row label="Awake" k="awake">
              {awakeMs === null ? "pending" : durationLabel(awakeMs)}
            </Row>
            <Row label="Auto-nap" k="idle">
              {idleLabel(billing ? status?.idleAt : undefined, now)}
            </Row>
          </>
        ) : (
          <>
            <Row label="Cost" k="cost">
              {FREE_WORD}
            </Row>
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
        )}
      </div>
      {status?.reason && (
        <p className={cn("mt-1.5 text-[11px] leading-relaxed", zombie ? "text-destructive-foreground" : "text-muted-foreground")} data-k="reason">
          {status.reason}
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

/** Every project golden this host took, read once for the tab: the lineage lists them under their versions and the
 * projects section adds the one it takes, so the two never read two lists. Read only where a lineage draws, since a
 * machine with no image behind it neither lists goldens nor takes one. */
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
 * with every project on it, offered only where the Lineage section draws: a machine with an image behind it. */
function Projects({ workspace, status, kind, onTaken }: { workspace: WorkspaceView; status: WorkspaceStatus | null; kind: WorkspaceKindWords; onTaken: (taken: ProjectGolden) => void }) {
  const api = useStore(s => s.api);
  const verbs = useWorkspaceVerbs();
  const projects = workspaceProjects(workspace);
  const importAction = actionById(resolveActions(workspaceActions, workspaceTarget(workspace, status), verbs, false), "import-project");
  const images = kind.machine === null && api?.snapshotWorkspace !== undefined;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const snapshot = async (): Promise<void> => {
    if (!api?.snapshotWorkspace) return;
    setBusy(true);
    try {
      const taken = await api.snapshotWorkspace(workspace.id);
      onTaken(taken);
      setNote(`Project golden of ${taken.projects.map(p => p.name).join(", ")} taken. New forks of it start with the projects in place.`);
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
          <Button size="xs" variant="outline" disabled={busy || projects.length === 0 || workspace.phase !== "running"} aria-label={`snapshot ${workspace.name} as a project golden`} onClick={() => void snapshot()}>
            Snapshot as image
          </Button>
        )}
      </div>
      <p className="mt-1 min-h-4 text-[11px] text-muted-foreground" data-k="projects-note">
        {busy ? "Taking the snapshot…" : note}
      </p>
    </Section>
  );
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The tab asks before it rebuilds, so its registry entry opens the dialog; the dialog's own button calls the api and
  // names a client without the verb.
  const action = actionById(resolveActions(workspaceActions, workspaceTarget(workspace, status), { ...verbs, rebuild: async () => setOpen(true) }, false), "rebuild");

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
      setNote("Machine rebuilt from the golden.");
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
              A fresh fork of the golden replaces this machine and imports its nap-time vault. The old machine is killed whatever it
              reports; anything running on it ends. Forking a new machine costs a wake.
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

type Stale = "napping" | "unreachable" | null;

/** cpu, memory and disk from the machine, one sparkline each. A napping workspace, or a running one whose link is
 * down, keeps the last values dim under the word for it; the daemon says nothing about a machine it is not on. A
 * daemon that refused the stream puts the word unavailable in the slots, and the runtime replaces a daemon too old
 * to serve them without anyone here asking: the machine's row says so while it does. A kind whose machines read no
 * metrics at all says so in the slots instead, rather than pending forever: no slot waits on a stream that will
 * never come. */
function Live({ workspace, kind }: { workspace: WorkspaceView; kind: WorkspaceKindWords }) {
  const live = useWorkspaceLive(workspace.id);
  const last = live.samples[live.samples.length - 1];
  const stale: Stale = workspace.phase === "napping" || workspace.phase === "pausing" ? "napping" : live.reach === "live" ? null : "unreachable";
  const kindWord = kind.metrics ? null : NOT_ON_THIS_KIND;
  const share = (m: { used: number; total: number }): number => (m.total > 0 ? (m.used / m.total) * 100 : 0);
  const row = { kindWord, stale, unavailable: live.unavailable, samples: live.samples };
  return (
    <Section label="Live" aside={kindWord === null && last !== undefined && stale === null ? `load ${last.load1.toFixed(2)}` : undefined}>
      <div className="mt-1 divide-y divide-border/40">
        <LiveRow {...row} label="cpu" k="cpu" y={s => s.cpu} text={s => percentLabel(s.cpu)} />
        <LiveRow {...row} label="memory" k="mem" y={s => share(s.mem)} text={s => bytesOfLabel(s.mem.used, s.mem.total)} />
        <LiveRow {...row} label="disk" k="disk" y={s => share(s.disk)} text={s => bytesOfLabel(s.disk.used, s.disk.total)} tier={s => diskTier(share(s.disk))} />
      </div>
    </Section>
  );
}

const TIER_CLASS: Record<DiskTier, string | undefined> = {
  plain: undefined,
  yellow: "text-warning-foreground",
  orange: "text-caution-foreground",
  red: "text-destructive-foreground",
};

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
  tier?: (s: SysSample) => DiskTier;
  stale: Stale;
  /** The daemon's refusal of the stream; the slot reads unavailable and carries it as the title. */
  unavailable: string | null;
  /** The kind table's word for a kind that reads none of this, put in the slot as it is; null on a kind that reads
   * it, where the slot is a value's or a fault's to fill. */
  kindWord: string | null;
}

/** One fixed-height row: label, sparkline, value. The value slot has a fixed width so a word in place of a number
 * moves nothing; a single sample draws as a dot through the round cap. Hovering reads that sample into the slot. */
function LiveRow({ label, k, samples, y, text, tier, stale, unavailable, kindWord }: LiveRowProps) {
  const [hover, setHover] = useState<number | null>(null);
  const points = sparkPoints(samples, y);
  const shown = hover !== null ? samples[hover] : samples[samples.length - 1];
  const word = kindWord ?? stale ?? (unavailable !== null ? "unavailable" : shown === undefined ? "pending" : null);
  const tone = word === null && shown !== undefined && tier ? TIER_CLASS[tier(shown)] : undefined;

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
        className={cn("truncate text-right font-mono tabular-nums", word !== null ? "text-muted-foreground/60" : (tone ?? "text-foreground"))}
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
  /** The action in flight, so the buttons wait for each other and the note names it. */
  const [busy, setBusy] = useState<"rollback" | "image" | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
      setNote(`New forks use v${version}. Existing workspaces keep their image.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const updateImage = async (to: number): Promise<void> => {
    if (!api?.updateImage) return;
    setBusy("image");
    try {
      applyWorkspace(await api.updateImage(workspace.id));
      setNote(`${workspace.name} is on v${to}. Its files came across; anything running in it stopped with the old machine.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const fork = (g: ProjectGolden): void => {
    void createWorkspace(`${goldenForkName(g)}-fork`, g.snapshotId);
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
    <Section label="Lineage" aside={lineage?.head !== null && lineage?.head !== undefined ? `head v${lineage.head}` : undefined}>
      <ul className={cn("mt-1 divide-y divide-border/40", LINEAGE_GRID)}>
        <LineageRow
          dot={workspace.phase === "running" ? "bg-success" : "border border-muted-foreground/60"}
          title={<span className="font-medium">Live disk</span>}
          detail={`forked ${workspace.createdAt.slice(0, 10)}`}
          marks={["now"]}
        />
        {versions.length === 0 ? (
          <LineageRow
            dot="bg-muted-foreground/60"
            title={
              <span className="truncate font-mono text-[.7rem]" data-k="golden">
                {workspace.golden}
              </span>
            }
            detail="golden base"
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
                      <Button size="xs" variant="outline" disabled={busy !== null || moveRefusal !== null} aria-label={`update ${workspace.name} to v${behind}`} onClick={() => void updateImage(behind)}>
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
      <p className="min-h-4 text-[11px] text-muted-foreground" data-k="lineage-note">
        {busy === "rollback" ? "Rolling back…" : busy === "image" ? "Moving to the newer image…" : (note ?? (behind !== null && moveRefusal !== null ? moveRefusal : null))}
      </p>
      <AlertDialog open={armed !== null} onOpenChange={open => !open && setArmed(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to v{armed?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              New forks use v{armed?.version}; head moves from v{lineage?.head} to v{armed?.version}. Workspaces already forked keep
              their image.
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

/** The lineage list's columns: dot, title, marks, buttons. The list owns the grid and every row, nested lists included,
 * is a subgrid of it, so the marks sit in one column and the buttons in the next across the whole section. */
const LINEAGE_GRID = "grid grid-cols-[0.375rem_minmax(0,1fr)_auto_auto] gap-x-2";
const LINEAGE_SUBGRID = "col-span-4 grid grid-cols-subgrid";

/** One row of the lineage grid at a button's height, so a wrapping detail or an appearing button moves nothing; a
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

/** One state word on a lineage row, muted mono like the row's other metadata: a state is text there, never a badge. */
function Mark({ kind }: { kind: LineageMark }) {
  return (
    <span className="font-mono text-muted-foreground" data-mark={kind}>
      {LINEAGE_MARKS[kind]}
    </span>
  );
}

/** The project goldens taken on forks of one version, newest first: the version's disk plus every project as it stood,
 * each a fork away from a task with no upload. */
function ProjectGoldens({ goldens, forkOf, busy, onFork }: { goldens: ProjectGolden[]; forkOf: string; busy: boolean; onFork: (g: ProjectGolden) => void }) {
  if (goldens.length === 0) return null;
  const rows = [...goldens].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <ul className={cn(LINEAGE_SUBGRID, "mt-1 divide-y divide-border/40")} aria-label="project goldens">
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
            <Button size="xs" variant="outline" disabled={busy} aria-label={`fork ${goldenForkName(g)} from ${g.snapshotId}`} onClick={() => onFork(g)}>
              Fork
            </Button>
          }
        />
      ))}
    </ul>
  );
}

/** A list under one lineage row, behind a micro-label: what the version is missing, what it left behind, what it
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

/** Pause or wake, upgrade and forget, for a machine wsp drives; a machine that already existed takes none of them, so
 * the tab ends at its facts. Each button is offered only while its verb can run: Pause while the machine bills, Wake
 * while it is paused, nothing while it moves between the two; Upgrade only on a provider that resizes and only while a
 * bigger size is on offer; Forget once the machine is gone. */
function Actions({ workspace, status, upgrade }: { workspace: WorkspaceView; status: WorkspaceStatus | null; upgrade: Upgrade }) {
  const verbs = useWorkspaceVerbs();
  const capabilities = useCapabilities();
  const sessions = useStore(s => s.sessions[workspace.id]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<MachineSizeOffer | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const gone = workspace.phase === "gone";
  // The tab's forget opens its own dialog, in place of the request the sidebar answers; the dialog names a client without the verb.
  const actions = resolveActions(workspaceActions, workspaceTarget(workspace, status), { ...verbs, forget: () => setForgetting(true) }, false);
  const phase = actionById(actions, "phase");
  const forget = actionById(actions, "forget");
  // Backend fact, not a probe: a provider that cannot resize gets no picker and no button.
  const options = status && capabilities?.resize === true ? upgradeOptions(status.size, capabilities.sizes) : [];
  const choice = picked ?? options[0] ?? null;
  const rate = status?.rateUsdPerHour ?? null;
  const driven = kindWords(workspaceKind(workspace)).driven;
  const offersUpgrade = status !== null && !gone && options.length > 0;
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
    offersUpgrade ? (
      <Button key="upgrade" size="sm" className="flex-1" disabled={upgrade.phase.kind === "resizing"} aria-label={`upgrade ${workspace.name}`} onClick={() => (open ? close() : setOpen(true))}>
        Upgrade
      </Button>
    ) : null,
  ].filter(button => button !== null);
  if (buttons.length === 0 && note === null && upgrade.phase.kind !== "failed") return null;
  return (
    <footer className="flex flex-col gap-2 border-t border-border/60 p-3">
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
