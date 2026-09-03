// SPDX-License-Identifier: AGPL-3.0-only
// The machine surface of the right panel: facts, spend, lineage with rollback,
// pause, wake, upgrade and rebuild for one workspace's machine.
import { CopyIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
import { divergentMachineState, durationLabel, idleLabel, money, phaseLabel, reachLabel, sizeLabel } from "./format.js";

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

function Row({ label, k, children }: { label: string; k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono tabular-nums text-foreground" data-k={k}>
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
        <Row label="State" k="state">
          {phaseLabel(workspace.phase)}
          {diverged && <span className="text-muted-foreground"> · machine {diverged}</span>}
        </Row>
        <Row label="Reach" k="reach">
          {status ? (
            <span className={cn(zombie && "text-destructive-foreground")} data-reach={status.reach.state}>
              {reachLabel(status.reach.state)}
            </span>
          ) : (
            "pending"
          )}
        </Row>
        <Row label="Size" k="size">
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
  const rates = series.map(p => p.rateUsdPerHour);
  const peak = rates.length > 0 ? Math.max(...rates) : null;
  return (
    <Section label="Usage" aside={peak !== null ? `peak ${money(peak, 2)}` : undefined}>
      <UsageChart rates={rates} sawSpend={cost !== null} />
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

/** One bar per cost tick. The series lives in this surface, so a tick that
 * landed before it mounted shows in the counters but not here; the empty text
 * has to say that rather than claim there was no spend. */
function UsageChart({ rates, sawSpend }: { rates: number[]; sawSpend: boolean }) {
  const max = Math.max(...rates, 0.001);
  return (
    <div
      className="mt-2 mb-1 flex h-16 items-end gap-px overflow-hidden rounded-md border border-border/40 bg-muted/8 px-1.5 pt-2 pb-1.5"
      role="img"
      aria-label="spend per hour, one bar per cost tick"
      data-usage-chart
    >
      {rates.length === 0 ? (
        <span className="w-full self-center text-center text-[11px] text-muted-foreground/60">
          {sawSpend ? "Chart starts with the next cost tick." : "No cost ticks yet."}
        </span>
      ) : (
        rates.map((rate, i) => (
          <span
            key={i}
            className="block min-h-px flex-1 rounded-t-sm bg-foreground/65"
            style={{ height: `${(rate / max) * 100}%` }}
            title={`${money(rate, 3)}/hr`}
            data-usage-bar
          />
        ))
      )}
    </div>
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
          disabled={waking}
          aria-label={`${running ? "pause" : "wake"} ${workspace.name}`}
          title={running ? "Suspend the VM and keep the disk" : "Boot the VM from its disk"}
          onClick={() => void toggle(workspace.id)}
        >
          {running ? "Pause" : waking ? "Waking…" : "Wake"}
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
