// SPDX-License-Identifier: AGPL-3.0-only
// The Workspace pane of the right panel: load, memory and disk as line
// charts over the last two minutes, the workspace's facts in two mono lines,
// and the registry's actions for it. On this computer's own panel the facts
// are this computer's and there is nothing to act on.
import { HERE_PLACE_ID, diskTone, fmtBytesOfTotal, fmtSize, kindWords, readingRoad, workspaceKind, workspaceStateOf, workspaceWord, type SizeTone, type SysSample, type WorkspaceView } from "@wsp/protocol";
import { runAction } from "../../actions/contextMenu.js";
import { actionIfAny, resolveActions, rowLabelOf } from "../../actions/registry.js";
import { useWorkspaceVerbs } from "../../actions/verbs.js";
import { workspaceActions, workspaceTarget } from "../../actions/workspaceActions.js";
import { TONE_TEXT } from "../../lib/tone.js";
import { cn } from "../../lib/utils.js";
import { LIVE_WINDOW, staleWord, useWorkspaceLive, type StaleWord } from "../../machine/live.js";
import { useAbsentComputer, useCapabilities, usePlaces, useStatus, useWorkspace } from "../../protocol/store.js";
import { placeName } from "../../settings/places.js";
import { whereRuns } from "../../sidebar/workspaceRows.js";
import { Button, DANGER_BUTTON } from "../ui/button.js";
import { ScrollArea } from "../ui/scroll-area.js";

/** The registry's actions this pane draws, in this order; the open verbs live on the tab strip and the row. */
const PANE_ACTIONS = ["phase", "start-daemon", "rebuild", "bring-back", "export-project", "delete", "forget"] as const;

export function MachineSurface({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const absent = useAbsentComputer(workspaceId);
  const live = useWorkspaceLive(workspaceId);
  // A local workspace's figures are read by the host, so its daemon being down says nothing about them.
  const daemonRead = workspace === null || readingRoad(workspaceKind(workspace), "metrics") === "daemon";
  const stale = (daemonRead ? absent?.away : undefined) ?? staleWord(workspace?.phase ?? "running", live.reach === "live");
  return (
    <div className="flex h-full min-h-0 flex-col" data-machine>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 py-3">
          <Charts samples={live.samples} stale={stale} unavailable={live.unavailable} />
          {workspace === null ? <HereFacts /> : <Facts workspace={workspace} />}
        </div>
      </ScrollArea>
      {workspace !== null && <Actions workspace={workspace} />}
    </div>
  );
}

const share = (m: { used: number; total: number }): number => (m.total > 0 ? m.used / m.total : 0);

function Charts({ samples, stale, unavailable }: { samples: SysSample[]; stale: StaleWord; unavailable: string | null }) {
  // Load has no ceiling of its own, so its line is drawn against the highest reading in the window, never below one.
  const loadTop = Math.max(1, ...samples.map(s => s.load1));
  const row = { samples, stale, unavailable };
  return (
    <div className="flex flex-col gap-3">
      <Chart {...row} label="load" k="load" y={s => s.load1 / loadTop} text={s => s.load1.toFixed(2)} tone={() => "muted"} />
      <Chart {...row} label="memory" k="mem" y={s => share(s.mem)} text={s => fmtBytesOfTotal(s.mem.used, s.mem.total)} tone={s => diskTone(s.mem.used, s.mem.total)} />
      <Chart {...row} label="disk" k="disk" y={s => share(s.disk)} text={s => fmtBytesOfTotal(s.disk.used, s.disk.total)} tone={s => diskTone(s.disk.used, s.disk.total)} />
    </div>
  );
}

const CHART_W = 100;
const CHART_H = 32;
const CHART_PAD = 1;

/** Sixty slots across with the newest sample in the last one, so a young series grows in from the right. */
export function chartPoints(samples: readonly SysSample[], y: (s: SysSample) => number): { x: number; y: number }[] {
  const span = CHART_H - 2 * CHART_PAD;
  return samples.map((s, i) => ({
    x: ((LIVE_WINDOW - samples.length + i) / (LIVE_WINDOW - 1)) * CHART_W,
    y: CHART_PAD + (1 - Math.min(1, Math.max(0, y(s)))) * span,
  }));
}

interface ChartProps {
  label: string;
  k: string;
  samples: SysSample[];
  /** The sample's height as a share of the chart, 0 to 1. */
  y: (s: SysSample) => number;
  text: (s: SysSample) => string;
  tone: (s: SysSample) => SizeTone;
  stale: StaleWord;
  unavailable: string | null;
}

function Chart({ label, k, samples, y, text, tone, stale, unavailable }: ChartProps) {
  const points = chartPoints(samples, y);
  const last = samples[samples.length - 1];
  const word = stale ?? (unavailable !== null ? "unavailable" : last === undefined ? "pending" : null);
  // A single sample draws as a dot through the round cap.
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join("") + (points.length === 1 ? `L${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}` : "");
  return (
    <div data-chart={k} {...(stale !== null ? { "data-stale": stale } : {})}>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[11px] tabular-nums">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={cn("truncate", word !== null ? "text-muted-foreground/60" : last !== undefined ? TONE_TEXT[tone(last)] : undefined)}
          data-k={k}
          {...(word === "unavailable" && unavailable !== null ? { title: unavailable } : {})}
        >
          {word ?? (last !== undefined ? text(last) : "")}
        </span>
      </div>
      <svg className="mt-1 block h-8 w-full border-b border-border/50" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label={`${label} over the last two minutes`}>
        {points.length > 0 && (
          <path
            d={d}
            fill="none"
            className={stale !== null ? "stroke-muted-foreground/40" : "stroke-foreground/80"}
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            data-chart-line
          />
        )}
      </svg>
    </div>
  );
}

function FactLines({ lines }: { lines: string[] }) {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground" data-facts>
      {lines.map(line => (
        <p key={line} className="truncate" title={line}>
          {line}
        </p>
      ))}
    </div>
  );
}

function Facts({ workspace }: { workspace: WorkspaceView }) {
  const status = useStatus(workspace.id);
  const places = usePlaces();
  const capabilities = useCapabilities();
  const absent = useAbsentComputer(workspace.id);
  const state = absent?.word ?? workspaceWord(workspaceStateOf(workspace, status), capabilities?.pauseMode);
  const size = status ? fmtSize(status.size, kindWords(workspaceKind(workspace)).cpu) : null;
  const first = [state, whereRuns(places, { workspace, status }), size].filter(part => part !== null).join(" · ");
  return <FactLines lines={[first, workspace.project.path]} />;
}

function HereFacts() {
  const place = usePlaces().find(p => p.id === HERE_PLACE_ID);
  if (place === undefined) return null;
  const first = [placeName(place, true), place.os ?? null, place.shape ? fmtSize(place.shape, "cores") : null].filter(part => part !== null).join(" · ");
  return <FactLines lines={[first]} />;
}

function Actions({ workspace }: { workspace: WorkspaceView }) {
  const status = useStatus(workspace.id);
  const places = usePlaces();
  const verbs = useWorkspaceVerbs();
  const resolved = resolveActions(workspaceActions, workspaceTarget(workspace, status, places), verbs);
  const actions = PANE_ACTIONS.flatMap(id => actionIfAny(resolved, id) ?? []);
  if (actions.length === 0) return null;
  return (
    <footer className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2.5" data-machine-actions>
      {actions.map(action => (
        <Button
          key={action.id}
          size="xs"
          variant="outline"
          className={cn(action.destructive && DANGER_BUTTON)}
          disabled={action.refusal !== null}
          title={action.refusal ?? action.hint ?? undefined}
          aria-label={rowLabelOf(action)}
          data-action={action.id}
          onClick={() => void runAction(action)}
        >
          {action.buttonWord ?? action.title}
        </Button>
      ))}
    </footer>
  );
}
