// SPDX-License-Identifier: AGPL-3.0-only
// Importing a folder on this Mac into a workspace: the folder is read into one
// dense summary, the secret-shaped files are the one loud element and only
// when the plan found some, one action starts the import, and the runtime's
// events fill a fixed set of step rows. The desktop shell offers the system
// picker; a browser tab has the path input alone and Enter reads it. The path
// shows as the person picked it; the plan speaks in realpaths, so the
// destination and the events are matched on that. A consent is for the plan
// the person read: editing the path drops the plan and its ticks until the
// folder is read again.
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtBytes, type ProjectImportEvent, type ProjectImportResult, type ProjectPlan, type ProjectSecret, type WorkspaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { errorText } from "../lib/utils.js";
import type { ProtocolEvent } from "../protocol/client.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { consentRequest, defaultConsent, importStepRows, isImportOf, landedLine, secretOffer } from "./importProject.js";
import { count, refusalOf, refusalTone, type Refusal } from "./projectTrip.js";
import { FactRow, FolderField, StatusLine, StepRows } from "./ProjectTripRows.js";

type Phase = "idle" | "importing" | "done";

/** What the import was asked with, so its events are recognised whatever the path spelling. */
interface Sent {
  readonly source: string;
  readonly plan: ProjectPlan | null;
}

/** The plan and the path, as typed, it was read for. */
interface Planned {
  readonly folder: string;
  readonly plan: ProjectPlan;
}

const IMPORTING = "Importing. This stays open until it lands; closing it would not stop the import.";

export function ImportProjectDialog({ workspace, initialSource, onClose }: { workspace: WorkspaceView; initialSource?: string; onClose: () => void }) {
  const api = useStore(s => s.api);
  const bridge = typeof window === "undefined" ? undefined : window.wsp?.pickFolder;
  const [source, setSource] = useState(initialSource ?? "");
  const [planned, setPlanned] = useState<Planned | null>(null);
  const plan = planned?.plan ?? null;
  const [reading, setReading] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [events, setEvents] = useState<ProjectImportEvent[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ProjectImportResult | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const sent = useRef<Sent>({ source: "", plan: null });

  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if (e.type === "project.import" && isImportOf(e, workspace.id, sent.current.source, sent.current.plan)) setEvents(prev => [...prev, e]);
    },
    [workspace.id],
  );
  useProtocolEvents(onEvent);

  const read = useCallback(
    async (path: string): Promise<void> => {
      const folder = path.trim();
      if (folder === "" || api?.planProject === undefined) return;
      setReading(true);
      setRefusal(null);
      setPlanned(null);
      setEvents([]);
      setResult(null);
      setPhase("idle");
      try {
        const next = await api.planProject(folder);
        setPlanned({ folder, plan: next });
        setTicked(defaultConsent(next.secrets));
      } catch (e) {
        setRefusal({ message: errorText(e), exists: false });
      } finally {
        setReading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (initialSource !== undefined) void read(initialSource);
  }, [initialSource, read]);

  const pick = async (): Promise<void> => {
    if (bridge === undefined) return;
    const picked = await bridge();
    if (picked === undefined) return;
    setSource(picked);
    await read(picked);
  };

  const start = async (replace: boolean): Promise<void> => {
    if (plan === null || api?.importProject === undefined) return;
    const { carry, rewrite } = consentRequest(plan.secrets, ticked);
    sent.current = { source, plan };
    setPhase("importing");
    setEvents([]);
    setRefusal(null);
    try {
      const landed = await api.importProject({ workspaceId: workspace.id, source, dest: plan.source, carry, rewrite, ...(replace ? { replace: true } : {}) });
      setResult(landed);
      setPhase("done");
    } catch (e) {
      setRefusal(refusalOf(e));
      setPhase("idle");
    }
  };

  const edit = (next: string): void => {
    setSource(next);
    if (planned !== null && next.trim() !== planned.folder) {
      setPlanned(null);
      setTicked(new Set());
      setRefusal(null);
    }
  };

  const toggle = (path: string, on: boolean): void => {
    setTicked(prev => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const busy = reading || phase === "importing";
  const primary = phase === "done" ? "Done" : refusal?.exists ? "Replace and import" : "Import";
  const status = refusal !== null ? refusal.message : result !== null ? landedLine(result, sent.current.source, workspace.name) : reading ? "Reading the folder." : phase === "importing" ? IMPORTING : "";

  return (
    <Dialog open onOpenChange={open => { if (!open && phase !== "importing") onClose(); }}>
      <DialogPopup className="sm:max-w-xl" showCloseButton={phase !== "importing"}>
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Import a project</DialogTitle>
            <DialogDescription>Into {workspace.name}. The folder lands on the machine at the path it has here; caches stay behind.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <FolderField
              id="import-source"
              label="Folder on this Mac"
              placeholder="/Users/you/code/project"
              value={source}
              disabled={busy}
              autoFocus={initialSource === undefined}
              onChange={edit}
              onEnter={() => void read(source)}
              {...(bridge === undefined ? {} : { onPick: () => void pick() })}
            />
            <Summary plan={plan} />
            {plan !== null && plan.secrets.length > 0 ? <Secrets secrets={plan.secrets} ticked={ticked} disabled={phase !== "idle"} onToggle={toggle} /> : null}
            <StepRows label="Import steps" transfer="Upload" rows={importStepRows(events)} />
            <StatusLine tone={refusalTone(refusal)}>{status}</StatusLine>
          </DialogPanel>
          <DialogFooter>
            {phase === "done" ? null : (
              <Button type="button" variant="outline" disabled={phase === "importing"} onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              type="button"
              disabled={phase !== "done" && (plan === null || busy || api?.importProject === undefined)}
              onClick={() => (phase === "done" ? onClose() : void start(refusal?.exists === true))}
            >
              {primary}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function Summary({ plan }: { plan: ProjectPlan | null }) {
  const skippedTitle = plan?.skipped.map(s => `${s.path}: ${s.note}`).join("\n");
  return (
    <div data-k="summary" className="divide-y divide-border/40 rounded-md border border-border/60 px-2.5">
      <FactRow label="Repository" k="repository">
        {plan === null ? "" : plan.repo ? "git, .git travels whole" : "none"}
      </FactRow>
      <FactRow label="Files" k="files">
        {plan === null ? "" : `${count(plan.files, "file")} · ${fmtBytes(plan.bytes)}`}
      </FactRow>
      <FactRow label="Caches left behind" k="caches">
        {plan === null ? "" : plan.excluded.length === 0 ? "none" : plan.excluded.join(", ")}
      </FactRow>
      <FactRow label="Not carried" k="skipped" {...(skippedTitle !== undefined && skippedTitle !== "" ? { title: skippedTitle } : {})}>
        {plan === null ? "" : plan.skipped.length === 0 ? "none" : count(plan.skipped.length, "path")}
      </FactRow>
      <FactRow label="Lands at" k="dest">
        {plan === null ? "" : plan.source}
      </FactRow>
    </div>
  );
}

function Secrets({ secrets, ticked, disabled, onToggle }: { secrets: readonly ProjectSecret[]; ticked: ReadonlySet<string>; disabled: boolean; onToggle: (path: string, on: boolean) => void }) {
  return (
    <section data-k="secrets" className="flex flex-col gap-1 rounded-md border border-warning/32 bg-warning-surface px-2.5 py-2">
      <p className="font-mono text-[11px] text-warning-foreground">{count(secrets.length, "secret-shaped file")}</p>
      <ul className="flex flex-col">
        {secrets.map(s => {
          const on = ticked.has(s.path);
          const offer = secretOffer(s, on);
          return (
            <li key={s.path} className="flex h-7 items-center gap-2 text-xs">
              <Checkbox checked={on} disabled={disabled} aria-label={s.path} onCheckedChange={next => onToggle(s.path, next)} />
              <span className="max-w-[45%] shrink-0 truncate font-mono text-foreground" title={s.path}>
                {s.path}
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{`${s.signals.join(", ")} · ${fmtBytes(s.bytes)}`}</span>
              <span data-k="offer" className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground" title={offer.full}>
                {offer.short}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">Ticked files travel; a ticked rewrite lands without its credentials; the rest is cut and named.</p>
    </section>
  );
}
