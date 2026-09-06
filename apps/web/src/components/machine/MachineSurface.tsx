// SPDX-License-Identifier: AGPL-3.0-only
// The machine surface of the right panel: facts, live utilisation, spend,
// lineage with rollback, pause, wake, upgrade and rebuild for one workspace's
// machine.
import { CopyIcon } from "lucide-react";
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { GoldenMissingTool, GoldenVersion, ProjectGolden, SnapshotLineage, SysSample, WorkspaceCostEvent, WorkspaceSize, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { provideDaemonUpdate, useDaemonUpdate, useDaemonVersion } from "../../files/wire.js";
import { cn, errorText } from "../../lib/utils.js";
import { daemonBehindLine } from "../../machine/daemon.js";
import { LIVE_WINDOW, useWorkspaceLive } from "../../machine/live.js";
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
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
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
  sizeLabel,
  type DiskTier,
} from "./format.js";
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header workspace={workspace} status={status} />
      <ScrollArea className="min-h-0 flex-1">
        <Facts workspace={workspace} status={status} awakeMs={last ? last.awakeMs : null} pendingSize={pendingSize} />
        <Live workspace={workspace} />
        <Usage workspace={workspace} status={status} series={series} />
        <Lineage workspace={workspace} />
      </ScrollArea>
      <Actions workspace={workspace} status={status} upgrade={upgrade} />
    </div>
  );
}

function Header({ workspace, status }: { workspace: WorkspaceView; status: WorkspaceStatus | null }) {
  const machineId = status?.machineId ?? workspace.machineId;
  const copy = (): void => {
    void navigator.clipboard?.writeText(machineId).catch(() => {});
  };
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <PhaseDot workspace={workspace} status={status} />
      <span className="min-w-0 truncate text-sm font-medium">{workspace.name}</span>
      <span className="ml-auto flex min-w-0 items-center gap-0.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="max-w-28 truncate" title={machineId} data-k="machine-id">
          {machineId}
        </span>
        <Button size="icon-micro" variant="ghost-muted" aria-label="Copy machine id" onClick={copy}>
          <CopyIcon />
        </Button>
      </span>
    </div>
  );
}

function PhaseDot({ workspace, status }: { workspace: WorkspaceView; status: WorkspaceStatus | null }) {
  const dead = status?.machineState === "gone" || status?.reach.state === "zombie";
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        dead
          ? "bg-destructive"
          : workspace.phase === "running"
            ? "bg-success"
            : workspace.phase === "waking"
              ? "animate-pulse bg-info"
              : "border border-muted-foreground/60",
      )}
    />
  );
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
}

function Facts({ workspace, status, awakeMs, pendingSize }: FactsProps) {
  const capabilities = useCapabilities();
  const now = useClock(status?.idleAt !== undefined);
  const diverged = status ? divergentMachineState(workspace.phase, status.machineState) : null;
  const zombie = status?.reach.state === "zombie";
  return (
    <Section label="Machine">
      <div className="mt-1 divide-y divide-border/40">
        <Row label="State" k="state" title={diverged ? `${phaseLabel(workspace.phase)} · machine ${diverged}` : phaseLabel(workspace.phase)}>
          {phaseLabel(workspace.phase)}
          {diverged && <span className="text-muted-foreground"> · machine {diverged}</span>}
        </Row>
        <Row label="Reach" k="reach" title={status ? reachLabel(status.reach.state) : "pending"}>
          {status ? (
            <span className={cn(zombie && "text-destructive-foreground")} data-reach={status.reach.state}>
              {reachLabel(status.reach.state)}
            </span>
          ) : (
            "pending"
          )}
        </Row>
        <Row label="Size" k="size" title={pendingSize ? `${sizeLabel(pendingSize)} · resizing` : status ? sizeLabel(status.size) : "pending"}>
          {pendingSize ? (
            <>
              {sizeLabel(pendingSize)}
              <span className="text-muted-foreground"> · resizing</span>
            </>
          ) : status ? (
            sizeLabel(status.size)
          ) : (
            "pending"
          )}
        </Row>
        <Row label="Awake" k="awake">
          {awakeMs === null ? "pending" : durationLabel(awakeMs)}
        </Row>
        <Row label="Auto-nap" k="idle">
          {idleLabel(status?.idleAt, now)}
        </Row>
      </div>
      {status?.reason && (
        <p className={cn("mt-1.5 text-[11px] leading-relaxed", zombie ? "text-destructive-foreground" : "text-muted-foreground")} data-k="reason">
          {status.reason}
        </p>
      )}
      {zombie && <Rebuild workspace={workspace} />}
      <p className="mt-1.5 text-[11px] text-muted-foreground/70">The idle window is fixed when a workspace is created.</p>
      {capabilities?.containers === false && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" data-k="containers">
          This provider's machines cannot run containers; install services natively.
        </p>
      )}
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

const WARN_BUTTON = "border-warning/50 text-warning-foreground [:hover,[data-pressed]]:border-warning [:hover,[data-pressed]]:bg-warning/8";

function Rebuild({ workspace }: { workspace: WorkspaceView }) {
  const api = useStore(s => s.api);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const rebuild = async (): Promise<void> => {
    setOpen(false);
    if (!api?.rebuild) {
      setNote("This client cannot rebuild machines.");
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
      <Button size="sm" variant="outline" className={WARN_BUTTON} disabled={busy} aria-label={`rebuild ${workspace.name}`} onClick={() => setOpen(true)}>
        {busy ? "Rebuilding…" : "Rebuild"}
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

/** cpu, memory and disk from the guest, one sparkline each. A napping workspace, or a running one whose link is
 * down, keeps the last values dim under the word for it; the daemon says nothing about a machine it is not on. A
 * daemon that refused the stream puts the word unavailable in the slots, and one older than this app gets a line
 * under the rows naming what it predates, with the update. */
function Live({ workspace }: { workspace: WorkspaceView }) {
  const live = useWorkspaceLive(workspace.id);
  const version = useDaemonVersion(workspace.id);
  const last = live.samples[live.samples.length - 1];
  const stale: Stale = workspace.phase === "napping" || workspace.phase === "pausing" ? "napping" : live.reach === "live" ? null : "unreachable";
  const share = (m: { used: number; total: number }): number => (m.total > 0 ? (m.used / m.total) * 100 : 0);
  const behind = workspace.phase === "running" ? daemonBehindLine(version) : null;
  return (
    <Section label="Live" aside={last !== undefined && stale === null ? `load ${last.load1.toFixed(2)}` : undefined}>
      <div className="mt-1 divide-y divide-border/40">
        <LiveRow label="cpu" k="cpu" samples={live.samples} y={s => s.cpu} text={s => percentLabel(s.cpu)} stale={stale} unavailable={live.unavailable} />
        <LiveRow label="memory" k="mem" samples={live.samples} y={s => share(s.mem)} text={s => bytesOfLabel(s.mem.used, s.mem.total)} stale={stale} unavailable={live.unavailable} />
        <LiveRow label="disk" k="disk" samples={live.samples} y={s => share(s.disk)} text={s => bytesOfLabel(s.disk.used, s.disk.total)} tier={s => diskTier(share(s.disk))} stale={stale} unavailable={live.unavailable} />
      </div>
      {behind !== null && <DaemonUpdate workspace={workspace} line={behind} />}
    </Section>
  );
}

/** One fixed-height line: what the machine's daemon predates, and the update as a keycap. The runtime redeploys the
 * daemon and the link redials on its own; the line leaves when the new hello names a current version. The keycap
 * stays busy until then, so a second click cannot run the deploy again while the old version is still on show. The
 * phase is the workspace's, not this mount's: the right panel unmounts the tab whenever another surface shows. */
function DaemonUpdate({ workspace, line }: { workspace: WorkspaceView; line: string }) {
  const api = useStore(s => s.api);
  const busy = useDaemonUpdate(workspace.id) !== null;
  const [note, setNote] = useState<string | null>(null);

  const update = async (): Promise<void> => {
    if (!api?.updateDaemon) {
      setNote("This client cannot update daemons.");
      return;
    }
    provideDaemonUpdate(workspace.id, "deploying");
    setNote(null);
    try {
      await api.updateDaemon(workspace.id);
      provideDaemonUpdate(workspace.id, "awaiting-hello");
    } catch (e) {
      setNote(errorText(e));
      provideDaemonUpdate(workspace.id, null);
    }
  };

  return (
    <div className="mt-1 flex h-6 items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground" data-k="daemon-update">
      <span className="min-w-0 truncate" title={note ?? line}>
        {note ?? line}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={busy}
              aria-label={`update the daemon on ${workspace.name}`}
              onClick={() => void update()}
              className="h-5 shrink-0 cursor-pointer rounded-sm border border-border bg-muted/40 px-1.5 text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-50"
            >
              {busy ? "updating" : "update"}
            </button>
          }
        />
        <TooltipPopup side="top">Restarts the daemon on the machine. Open terminals end, chat threads keep running.</TooltipPopup>
      </Tooltip>
    </div>
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
}

/** One fixed-height row: label, sparkline, value. The value slot has a fixed width so a word in place of a number
 * moves nothing; a single sample draws as a dot through the round cap. Hovering reads that sample into the slot. */
function LiveRow({ label, k, samples, y, text, tier, stale, unavailable }: LiveRowProps) {
  const [hover, setHover] = useState<number | null>(null);
  const points = sparkPoints(samples, y);
  const shown = hover !== null ? samples[hover] : samples[samples.length - 1];
  const word = stale ?? (unavailable !== null ? "unavailable" : shown === undefined ? "pending" : null);
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
      {...(stale !== null ? { "data-stale": stale } : {})}
      {...(unavailable !== null ? { "data-unavailable": unavailable } : {})}
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
  const rate = cost?.rateUsdPerHour ?? (workspace.phase === "running" ? status?.rateUsdPerHour ?? 0 : 0);
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

function Lineage({ workspace }: { workspace: WorkspaceView }) {
  const api = useStore(s => s.api);
  const createWorkspace = useStore(s => s.createWorkspace);
  const [lineage, setLineage] = useState<SnapshotLineage | null>(null);
  const [projects, setProjects] = useState<ProjectGolden[]>([]);
  /** Version whose rollback awaits the confirm dialog. */
  const [armed, setArmed] = useState<GoldenVersion | null>(null);
  /** The action in flight, so the two buttons wait for each other and the note names it. */
  const [busy, setBusy] = useState<"rollback" | "snapshot" | null>(null);
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
    api.listProjectGoldens?.().then(
      p => {
        if (current) setProjects(p);
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

  const snapshot = async (): Promise<void> => {
    const project = workspace.project;
    if (!api?.snapshotWorkspace || project === undefined) return;
    setBusy("snapshot");
    try {
      await api.snapshotWorkspace(workspace.id);
      load();
      setNote(`Project golden of ${project.name} taken. New forks of it start with the project.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const fork = (g: ProjectGolden): void => {
    void createWorkspace(`${g.project.name}-fork`, g.snapshotId);
  };

  const under = (snapshotId: string): ReactNode => <ProjectGoldens goldens={projects.filter(p => p.golden === snapshotId)} forkOf={workspace.golden} busy={busy !== null} onFork={fork} />;
  const versions = lineage ? [...lineage.versions].sort((a, b) => b.version - a.version) : [];
  const project = workspace.project;
  return (
    <Section label="Lineage" aside={lineage?.head !== null && lineage?.head !== undefined ? `head v${lineage.head}` : undefined}>
      <ul className="mt-1 divide-y divide-border/40">
        <LineageRow
          dot={workspace.phase === "running" ? "bg-success" : "border border-muted-foreground/60"}
          title={<span className="font-medium">Live disk</span>}
          detail={`forked ${workspace.createdAt.slice(0, 10)}${project !== undefined ? ` · ${project.name} imported ${project.importedAt.slice(0, 10)}` : ""}`}
          aside={
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">now</span>
              {project !== undefined && api?.snapshotWorkspace !== undefined && (
                <Button size="xs" variant="outline" disabled={busy !== null || workspace.phase !== "running"} aria-label={`snapshot ${workspace.name} as a project golden`} onClick={() => void snapshot()}>
                  Snapshot
                </Button>
              )}
            </span>
          }
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
                  <span className="flex min-w-0 items-center gap-1.5" data-k={`v${v.version}`}>
                    <span className="font-mono">v{v.version}</span>
                    {head && (
                      <Badge size="sm" variant="secondary">
                        head
                      </Badge>
                    )}
                    {fork && (
                      <Badge size="sm" variant="outline">
                        this fork
                      </Badge>
                    )}
                  </span>
                }
                detail={`built ${v.createdAt.slice(0, 10)}`}
                below={
                  <>
                    {fork && v.missingTools !== undefined && v.missingTools.length > 0 && <MissingTools tools={v.missingTools} />}
                    {under(v.snapshotId)}
                  </>
                }
                aside={
                  !head && (
                    <Button size="xs" variant="outline" disabled={busy !== null} aria-label={`roll back to v${v.version}`} onClick={() => setArmed(v)}>
                      Roll back
                    </Button>
                  )
                }
              />
            );
          })
        )}
      </ul>
      <p className="min-h-4 text-[11px] text-muted-foreground" data-k="lineage-note">
        {busy === "rollback" ? "Rolling back…" : busy === "snapshot" ? "Taking the snapshot…" : note}
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

/** Dot, title and aside share one row at a button's height, so a wrapping detail or an appearing button moves nothing. */
function LineageRow({ dot, title, detail, aside, below }: { dot: string; title: ReactNode; detail: string; aside?: ReactNode; below?: ReactNode }) {
  return (
    <li className="py-1.5 text-xs">
      <div className="grid grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
        <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
        <span className="flex min-w-0 items-center">{title}</span>
        <span className="flex min-h-6 items-center text-[11px]">{aside}</span>
        <span className="col-span-2 col-start-2 text-[11px] text-muted-foreground">{detail}</span>
      </div>
      {below}
    </li>
  );
}

/** The project goldens taken on forks of one version, newest first: the version's disk plus a project as it stood, each a
 * fork away from a task with no upload. */
function ProjectGoldens({ goldens, forkOf, busy, onFork }: { goldens: ProjectGolden[]; forkOf: string; busy: boolean; onFork: (g: ProjectGolden) => void }) {
  if (goldens.length === 0) return null;
  const rows = [...goldens].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <ul className="mt-1 ml-3.5 divide-y divide-border/40" aria-label="project goldens">
      {rows.map(g => (
        <LineageRow
          key={g.snapshotId}
          dot="border border-muted-foreground/60"
          title={
            <span className="flex min-w-0 items-center gap-1.5" data-k={`pg-${g.snapshotId}`}>
              <span className="truncate font-mono">{g.project.name}</span>
              {g.snapshotId === forkOf && (
                <Badge size="sm" variant="outline">
                  this fork
                </Badge>
              )}
            </span>
          }
          detail={`snapshot ${g.createdAt.slice(0, 10)} · imported ${g.project.importedAt.slice(0, 10)} · from ${g.workspaceName}`}
          aside={
            <Button size="xs" variant="outline" disabled={busy} aria-label={`fork ${g.project.name} from ${g.snapshotId}`} onClick={() => onFork(g)}>
              Fork
            </Button>
          }
        />
      ))}
    </ul>
  );
}

/** One row per tool the import left off the image, with its cause and reason: a count would not say why a tool is missing. */
function MissingTools({ tools }: { tools: GoldenMissingTool[] }) {
  return (
    <div className="mt-1.5 ml-3.5" data-k="missing-tools">
      <p className="text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">not on this image</p>
      <ul className="mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-muted-foreground" aria-label="tools not on this image">
        {tools.map(t => (
          <li key={t.id} className="contents">
            <span data-k="missing-tool">{t.name}</span>
            <span className="min-w-0 break-words" data-k="missing-note">
              {t.outcome}: {t.note}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Actions({ workspace, status, upgrade }: { workspace: WorkspaceView; status: WorkspaceStatus | null; upgrade: Upgrade }) {
  const toggle = useStore(s => s.toggle);
  const capabilities = useCapabilities();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<WorkspaceSize | null>(null);
  const running = workspace.phase === "running";
  const waking = workspace.phase === "waking";
  const pausing = workspace.phase === "pausing";
  // Backend fact, not a probe: a provider that cannot resize gets no picker at all.
  const canResize = capabilities?.resize === true;
  const options = status && canResize ? upgradeOptions(status.size) : [];
  const choice = picked ?? options[0] ?? null;
  const rate = status?.rateUsdPerHour ?? null;

  const close = (): void => {
    setOpen(false);
    setPicked(null);
  };
  const confirm = (): void => {
    if (!choice) return;
    close();
    upgrade.run(choice);
  };

  return (
    <footer className="flex flex-col gap-2 border-t border-border/60 p-3">
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          disabled={waking || pausing}
          aria-label={`${running ? "pause" : "wake"} ${workspace.name}`}
          title={running ? "Suspend the VM and keep the disk" : "Boot the VM from its disk"}
          onClick={() => void toggle(workspace.id)}
        >
          {running ? "Pause" : waking ? "Waking…" : pausing ? "Pausing…" : "Wake"}
        </Button>
        <Button
          size="sm"
          className="flex-1"
          disabled={!status || !canResize || options.length === 0 || upgrade.phase.kind === "resizing"}
          aria-label={`upgrade ${workspace.name}`}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {status && canResize && options.length === 0 ? "Largest size" : "Upgrade"}
        </Button>
      </div>
      {capabilities && !canResize && (
        <p className="text-[11px] leading-relaxed text-muted-foreground" data-k="resize-hint">
          This provider cannot resize a machine. Pick the size when you create a workspace.
        </p>
      )}
      {open && status && choice && (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2.5">
          {options.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {options.map(o => (
                <Button
                  key={o.cpu}
                  size="xs"
                  variant="outline"
                  aria-pressed={o.cpu === choice.cpu}
                  className={cn(o.cpu === choice.cpu && "border-foreground/60")}
                  onClick={() => setPicked(o)}
                >
                  {sizeLabel(o)}
                </Button>
              ))}
            </div>
          )}
          <div className="divide-y divide-border/40">
            <Row label="Current" k="resize-from">
              {sizeLabel(status.size)}
              {rate !== null ? ` · ${money(rate, 3)}/hr` : ""}
            </Row>
            <Row label="New" k="resize-to">
              {sizeLabel(choice)}
              {rate !== null ? ` · ~${money((rate * choice.cpu) / status.size.cpu, 3)}/hr` : ""}
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
      <p className="min-h-4 text-[11px] text-muted-foreground" role="status">
        {upgrade.phase.kind === "resizing" && "Resizing…"}
        {upgrade.phase.kind === "settling" && "Resized."}
        {upgrade.phase.kind === "failed" && (
          <button type="button" className="cursor-pointer text-left text-destructive-foreground" onClick={upgrade.dismiss}>
            {upgrade.phase.message}
          </button>
        )}
      </p>
    </footer>
  );
}
