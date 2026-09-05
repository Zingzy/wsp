// SPDX-License-Identifier: AGPL-3.0-only
// The machine surface of the right panel: facts, spend, lineage with rollback,
// pause, wake, upgrade and rebuild for one workspace's machine.
import { CopyIcon } from "lucide-react";
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { GoldenVersion, SnapshotLineage, WorkspaceSize, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { upgradeOptions, useCostSeries, useUpgrade, type CostPoint, type Upgrade } from "../../protocol/machine.js";
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
import { clockLabel, divergentMachineState, durationLabel, idleLabel, money, phaseLabel, reachLabel, sizeLabel } from "./format.js";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

function Surface({ workspace, series }: { workspace: WorkspaceView; series: CostPoint[] }) {
  const status = useStatus(workspace.id);
  const upgrade = useUpgrade(workspace.id);
  const last = series[series.length - 1];
  const pendingSize = upgrade.phase.kind === "resizing" || upgrade.phase.kind === "settling" ? upgrade.phase.size : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header workspace={workspace} status={status} />
      <ScrollArea className="min-h-0 flex-1">
        <Facts workspace={workspace} status={status} awakeMs={last ? last.awakeMs : null} pendingSize={pendingSize} />
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

function Usage({ workspace, status, series }: { workspace: WorkspaceView; status: WorkspaceStatus | null; series: CostPoint[] }) {
  const cost = useCost(workspace.id);
  const rate = cost?.rateUsdPerHour ?? (workspace.phase === "running" ? status?.rateUsdPerHour ?? 0 : 0);
  const peak = series.length > 0 ? Math.max(...series.map(p => p.rateUsdPerHour)) : null;
  return (
    <Section label="Usage" aside={peak !== null ? `peak ${money(peak, 2)}` : undefined}>
      <UsageChart series={series} sawSpend={cost !== null} />
      <div className="divide-y divide-border/40">
        <Row label="Rate now" k="rate">
          {`${money(rate, 3)}/hr`}
        </Row>
        <Row label="Accrued" k="accrued">
          {money(cost?.accruedUsd ?? 0)}
        </Row>
      </div>
    </Section>
  );
}

/** The drawing box the line is laid out in; the svg stretches it to the panel, and the stroke keeps its width. */
const CHART_W = 100;
const CHART_H = 40;
/** Room around the line so a dot on the peak, on zero or on the newest tick sits inside the box. */
const CHART_PAD = 4;
const CHART_PAD_X = 1.5;

/** Where each tick lands in the box: newest at the right edge, the peak at the top. */
function chartPoints(series: CostPoint[]): { x: number; y: number }[] {
  const max = Math.max(...series.map(p => p.rateUsdPerHour), 0.001);
  const span = CHART_H - 2 * CHART_PAD;
  const width = CHART_W - 2 * CHART_PAD_X;
  return series.map((p, i) => ({
    x: CHART_PAD_X + (series.length === 1 ? width : (i / (series.length - 1)) * width),
    y: CHART_PAD + (1 - p.rateUsdPerHour / max) * span,
  }));
}

/** One line through the cost ticks, the peak marked, the tick under the pointer read out under the box. The series lives
 * in this surface, so a tick that landed before it mounted shows in the counters but not here; the empty text has to
 * say that rather than claim there was no spend. */
function UsageChart({ series, sawSpend }: { series: CostPoint[]; sawSpend: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = chartPoints(series);
  const peakAt = series.reduce((best, p, i) => (p.rateUsdPerHour > series[best]!.rateUsdPerHour ? i : best), 0);
  const over = hover !== null ? series[hover] : undefined;
  const first = series[0];
  const last = series[series.length - 1];
  const readout = over !== undefined ? `${money(over.rateUsdPerHour, 3)}/hr at ${clockLabel(over.at)}` : first === undefined || last === undefined ? "" : first === last ? clockLabel(first.at) : `${clockLabel(first.at)} to ${clockLabel(last.at)}`;

  const track = (e: ReactMouseEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || series.length === 0) return;
    // The inverse of chartPoints, so the hairline lands on the mark under the pointer and not a pad's width beside it.
    const x = ((e.clientX - box.left) / box.width) * CHART_W;
    const at = Math.round(((x - CHART_PAD_X) / (CHART_W - 2 * CHART_PAD_X)) * (series.length - 1));
    setHover(Math.min(series.length - 1, Math.max(0, at)));
  };

  return (
    <div className="mt-2 mb-1" data-usage-chart>
      <div className="relative h-16 overflow-hidden rounded-md border border-border/40 bg-muted/8">
        {series.length === 0 ? (
          <span className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground/60">
            {sawSpend ? "Chart starts with the next cost tick." : "No cost ticks yet."}
          </span>
        ) : (
          <>
            <svg
              className="block size-full"
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="spend per hour over the ticks recorded, one line"
              onMouseMove={track}
              onMouseLeave={() => setHover(null)}
            >
              <path d={points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join("")} fill="none" className="stroke-foreground/80" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-usage-line />
              {hover !== null && points[hover] !== undefined && (
                <line x1={points[hover].x} x2={points[hover].x} y1={0} y2={CHART_H} className="stroke-muted-foreground/50" strokeWidth={1} vectorEffect="non-scaling-stroke" data-usage-hover />
              )}
            </svg>
            <ChartDot point={points[hover ?? peakAt]!} label={hover === null ? `${money(series[peakAt]!.rateUsdPerHour, 3)}/hr` : undefined} />
          </>
        )}
      </div>
      <p className="mt-1 min-h-4 text-right font-mono text-[11px] tabular-nums text-muted-foreground" data-k="usage-readout">
        {readout}
      </p>
    </div>
  );
}

/** A dot on one point of the box, drawn outside the svg so the stretch does not squash it. The label hangs under the
 * dot, where nothing of the line is higher than the peak, and leans away from the nearer edge. */
function ChartDot({ point, label }: { point: { x: number; y: number }; label: string | undefined }) {
  const left = (point.x / CHART_W) * 100;
  const top = (point.y / CHART_H) * 100;
  const flip = left > 60;
  return (
    <>
      <span aria-hidden className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" style={{ left: `${left}%`, top: `${top}%` }} data-usage-peak />
      {label !== undefined && (
        <span
          className={cn("pointer-events-none absolute mt-1.5 font-mono text-[10px] leading-none tabular-nums text-muted-foreground", flip ? "-translate-x-full pr-1.5" : "pl-1.5")}
          style={{ left: `${left}%`, top: `${top}%` }}
          data-k="usage-peak"
        >
          {label}
        </span>
      )}
    </>
  );
}

function Lineage({ workspace }: { workspace: WorkspaceView }) {
  const api = useStore(s => s.api);
  const [lineage, setLineage] = useState<SnapshotLineage | null>(null);
  /** Version whose rollback awaits the confirm dialog. */
  const [armed, setArmed] = useState<GoldenVersion | null>(null);
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    try {
      const result = await api.rollbackSnapshot(version);
      setLineage(result.lineage);
      setNote(`New forks use v${version}. Existing workspaces keep their image.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const versions = lineage ? [...lineage.versions].sort((a, b) => b.version - a.version) : [];
  return (
    <Section label="Lineage" aside={lineage?.head !== null && lineage?.head !== undefined ? `head v${lineage.head}` : undefined}>
      <ul className="mt-1 divide-y divide-border/40">
        <LineageRow
          dot={workspace.phase === "running" ? "bg-success" : "border border-muted-foreground/60"}
          title={<span className="font-medium">Live disk</span>}
          detail={`forked ${workspace.createdAt.slice(0, 10)}`}
          aside={<span className="text-muted-foreground">now</span>}
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
          />
        ) : (
          versions.map(v => {
            const head = v.version === lineage?.head;
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
                    {v.snapshotId === workspace.golden && (
                      <Badge size="sm" variant="outline">
                        this fork
                      </Badge>
                    )}
                  </span>
                }
                detail={`built ${v.createdAt.slice(0, 10)}`}
                aside={
                  !head && (
                    <Button size="xs" variant="outline" disabled={busy} aria-label={`roll back to v${v.version}`} onClick={() => setArmed(v)}>
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
        {busy ? "Rolling back…" : note}
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

function LineageRow({ dot, title, detail, aside }: { dot: string; title: ReactNode; detail: string; aside?: ReactNode }) {
  return (
    <li className="grid grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 text-xs">
      <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      <span className="flex min-w-0 flex-col gap-0.5">
        {title}
        <span className="text-[11px] text-muted-foreground">{detail}</span>
      </span>
      <span className="flex items-center text-[11px]">{aside}</span>
    </li>
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
