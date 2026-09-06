// SPDX-License-Identifier: AGPL-3.0-only
// Exporting a folder from a workspace's machine to this Mac, the reverse of
// the import: the folder on the machine opens as the thread's own, the
// destination here mirrors it until the person edits or picks one, the agents
// with threads on the workspace are ticked rows, named as the catalog names
// them, whose sessions come home, one
// action starts the export, and the runtime's events fill a fixed set of step
// rows. Nothing is read from the machine before the destination is checked, so
// an existing folder comes back as the runtime's refusal naming it and its
// file count, the one loud line, and the action becomes Replace and export.
import { useCallback, useMemo, useRef, useState } from "react";
import { fmtBytes, type ProjectAgentResult, type ProjectExportEvent, type ProjectExportResult, type WorkspaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { useThreadFolder } from "../files/root.js";
import type { ProtocolEvent } from "../protocol/client.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { agentRows, agentsRequest, exportLandedLine, exportStepRows, isExportOf, pickedDest } from "./exportProject.js";
import { agentName, agentOutcome, count, refusalOf, refusalTone, type Refusal } from "./projectTrip.js";
import { FactRow, FolderField, StatusLine, StepRows } from "./ProjectTripRows.js";

type Phase = "idle" | "exporting" | "done";

const EXPORTING = "Exporting. This stays open until it lands; closing it would not stop the export.";

export function ExportProjectDialog({ workspace, onClose }: { workspace: WorkspaceView; onClose: () => void }) {
  const api = useStore(s => s.api);
  const sessions = useStore(s => s.sessions[workspace.id]);
  const rows = useMemo(() => agentRows(sessions), [sessions]);
  const folder = useThreadFolder(workspace.id);
  const bridge = typeof window === "undefined" ? undefined : window.wsp?.pickFolder;
  const [source, setSource] = useState(folder ?? "");
  /** The destination once the person edited or picked it; before that it mirrors the source. */
  const [chosen, setChosen] = useState<string | null>(null);
  const dest = chosen ?? source;
  /** Rows start ticked, so the set holds the ones the person cleared and a row that arrives later starts ticked too. */
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const ticked = useMemo(() => new Set(rows.filter(r => !unticked.has(r))), [rows, unticked]);
  const [events, setEvents] = useState<ProjectExportEvent[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ProjectExportResult | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const sent = useRef({ source: "", dest: "" });

  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if (e.type === "project.export" && isExportOf(e, workspace.id, sent.current.dest)) setEvents(prev => [...prev, e]);
    },
    [workspace.id],
  );
  useProtocolEvents(onEvent);

  const pick = async (): Promise<void> => {
    if (bridge === undefined) return;
    const picked = await bridge();
    if (picked === undefined) return;
    setChosen(pickedDest(picked, source));
    setRefusal(null);
  };

  const start = async (replace: boolean): Promise<void> => {
    if (api?.exportProject === undefined) return;
    const agents = agentsRequest(rows, ticked);
    sent.current = { source: source.trim(), dest: dest.trim() };
    setPhase("exporting");
    setEvents([]);
    setRefusal(null);
    try {
      const landed = await api.exportProject({ workspaceId: workspace.id, ...sent.current, ...(replace ? { replace: true } : {}), ...(agents !== undefined ? { agents } : {}) });
      setResult(landed);
      setPhase("done");
    } catch (e) {
      setRefusal(refusalOf(e));
      setPhase("idle");
    }
  };

  const toggle = (agent: string, on: boolean): void => {
    setUnticked(prev => {
      const next = new Set(prev);
      if (on) next.delete(agent);
      else next.add(agent);
      return next;
    });
  };

  const busy = phase === "exporting";
  const ready = source.trim() !== "" && dest.trim() !== "";
  const primary = phase === "done" ? "Done" : refusal?.exists ? "Replace and export" : "Export";
  const status = refusal !== null ? refusal.message : result !== null ? exportLandedLine(result, sent.current.source) : busy ? EXPORTING : "";
  const outcomeOf = (agent: string): ProjectAgentResult | undefined => result?.agents.find(a => a.agent === agent);

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogPopup className="sm:max-w-xl" showCloseButton={!busy}>
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Export a project</DialogTitle>
            <DialogDescription>From {workspace.name}. The folder lands on this Mac with the sessions keyed to it; caches stay behind on the machine.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <FolderField
              id="export-source"
              label="Folder on the machine"
              placeholder="/root/project"
              value={source}
              disabled={busy || phase === "done"}
              autoFocus={folder === null}
              onChange={next => {
                setSource(next);
                setRefusal(null);
              }}
            />
            <FolderField
              id="export-dest"
              label="Folder on this Mac"
              placeholder="/Users/you/code/project"
              value={dest}
              disabled={busy || phase === "done"}
              onChange={next => {
                setChosen(next);
                setRefusal(null);
              }}
              {...(bridge === undefined ? {} : { onPick: () => void pick() })}
            />
            <Agents rows={rows} ticked={ticked} disabled={phase !== "idle"} outcomeOf={outcomeOf} onToggle={toggle} />
            <div data-k="summary" className="divide-y divide-border/40 rounded-md border border-border/60 px-2.5">
              <FactRow label="Files" k="files">
                {result === null ? "" : `${count(result.files, "file")} · ${fmtBytes(result.bytes)}`}
              </FactRow>
              <FactRow label="Caches left behind" k="caches">
                {result === null ? "" : result.excluded.length === 0 ? "none" : result.excluded.join(", ")}
              </FactRow>
            </div>
            <StepRows label="Export steps" transfer="Download" rows={exportStepRows(events)} />
            <StatusLine tone={refusalTone(refusal)}>{status}</StatusLine>
          </DialogPanel>
          <DialogFooter>
            {phase === "done" ? null : (
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button type="button" disabled={phase !== "done" && (!ready || busy || api?.exportProject === undefined)} onClick={() => (phase === "done" ? onClose() : void start(refusal?.exists === true))}>
              {primary}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function Agents({
  rows,
  ticked,
  disabled,
  outcomeOf,
  onToggle,
}: {
  rows: readonly string[];
  ticked: ReadonlySet<string>;
  disabled: boolean;
  outcomeOf: (agent: string) => ProjectAgentResult | undefined;
  onToggle: (agent: string, on: boolean) => void;
}) {
  return (
    <section data-k="agents" className="flex flex-col gap-1 rounded-md border border-border/60 px-2.5 py-2">
      <p className="font-mono text-[11px] text-muted-foreground">{rows.length === 0 ? "No threads here; every agent with sessions for the folder comes along." : `${count(rows.length, "agent")} with threads here`}</p>
      {rows.length === 0 ? null : (
        <ul className="flex flex-col">
          {rows.map(agent => {
            const landed = outcomeOf(agent);
            const name = agentName(agent);
            return (
              <li key={agent} className="flex h-7 items-center gap-2 text-xs">
                <Checkbox checked={ticked.has(agent)} disabled={disabled} aria-label={name} onCheckedChange={next => onToggle(agent, next)} />
                <span className="shrink-0 text-foreground">{name}</span>
                {landed?.sessions === undefined ? null : <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{count(landed.sessions, "session")}</span>}
                <span data-k="outcome" className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
                  {landed === undefined ? "" : agentOutcome(landed)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length === 0 ? null : <p className="text-[11px] text-muted-foreground">Ticked agents' sessions come home keyed to the new path; the rest stay on the machine.</p>}
    </section>
  );
}
