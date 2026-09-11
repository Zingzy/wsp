// SPDX-License-Identifier: AGPL-3.0-only
// Importing a folder on this Mac into a workspace: one container of quiet
// sections, the folder, what travels, the agents whose sessions go with it
// and the files that look like secrets, each a section only when the plan
// has rows for it; one action starts the import and the runtime's events
// read in the one slot above the footer that was empty until then. The
// desktop shell gives the folder as a picker row; a browser tab browses the
// host's own folders under the path input, and a typed path with Enter
// reads it either way. The path shows as the person picked it; the plan
// speaks in realpaths, so the destination and the events are matched on
// that. A consent is for the plan the person read: editing the path drops
// the plan and its ticks until the folder is read again.
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtBytes, importDest, importIntoLine, importRequest, repoLine, secretSignalsLine, secretsNote, SESSIONS_NOTE, type ProjectAgent, type ProjectImportEvent, type ProjectImportResult, type ProjectPlan, type ProjectSecret, type WorkspaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { errorText } from "../lib/utils.js";
import type { ProtocolEvent } from "../protocol/client.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { FolderBrowser } from "./FolderBrowser.js";
import { agentState, canTravel, defaultAgents, defaultConsent, importProgress, isImportOf, landedLine, secretOffer } from "./importProject.js";
import { useLastFolderParent, useLastFolderStore } from "./lastFolderStore.js";
import { count, refusalOf, slotWords, type Refusal } from "./projectTrip.js";
import { CachesRow, ConsentRow, FactRow, FolderField, FolderPickerRow, TripSection, TripStatus } from "./ProjectTripRows.js";

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

const PLACEHOLDER = "/Users/you/code/project";

export function ImportProjectDialog({ workspace, initialSource, onClose }: { workspace: WorkspaceView; initialSource?: string; onClose: () => void }) {
  const api = useStore(s => s.api);
  const bridge = desktopBridge()?.pickFolder;
  const remember = useLastFolderStore(s => s.remember);
  const lastFolder = useLastFolderParent();
  const [source, setSource] = useState(initialSource ?? "");
  const [planned, setPlanned] = useState<Planned | null>(null);
  const plan = planned?.plan ?? null;
  const [reading, setReading] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [tickedAgents, setTickedAgents] = useState<ReadonlySet<string>>(new Set());
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
        setTickedAgents(defaultAgents(next.agents));
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

  const pick = (picked: string): void => {
    setSource(picked);
    void read(picked);
  };

  const pickNative = async (): Promise<void> => {
    if (bridge === undefined) return;
    const picked = await bridge();
    if (picked !== undefined) pick(picked);
  };

  const start = async (replace: boolean): Promise<void> => {
    if (plan === null || api?.importProject === undefined) return;
    sent.current = { source, plan };
    setPhase("importing");
    setEvents([]);
    setRefusal(null);
    try {
      const landed = await api.importProject({ workspaceId: workspace.id, ...importRequest(plan, source, ticked, tickedAgents, replace, workspace) });
      setResult(landed);
      setPhase("done");
      remember(source.trim());
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
      setTickedAgents(new Set());
      setRefusal(null);
    }
  };

  const toggled = (prev: ReadonlySet<string>, id: string, on: boolean): Set<string> => {
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  const toggle = (path: string, on: boolean): void => setTicked(prev => toggled(prev, path, on));
  const toggleAgent = (agent: string, on: boolean): void => setTickedAgents(prev => toggled(prev, agent, on));

  const busy = reading || phase === "importing";
  const primary = phase === "done" ? "Done" : refusal?.exists ? "Replace and import" : "Import";
  const progress = phase === "idle" ? null : importProgress(events, workspace.name);
  const said = slotWords({ refusal, landed: result === null ? null : landedLine(result, sent.current.source, workspace.name), progress, idle: reading ? "Reading the folder." : "" });

  return (
    <Dialog open onOpenChange={open => { if (!open && phase !== "importing") onClose(); }}>
      <DialogPopup className="sm:max-w-xl" showCloseButton={phase !== "importing"}>
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Import a project</DialogTitle>
            <DialogDescription>{importIntoLine(workspace.name)}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col">
            <TripSection k="folder" label="Folder on this Mac" {...(bridge === undefined ? { htmlFor: "import-source" } : {})}>
              {bridge === undefined ? (
                <>
                  <FolderField id="import-source" placeholder={PLACEHOLDER} value={source} disabled={busy} autoFocus={initialSource === undefined} onChange={edit} onEnter={() => void read(source)} />
                  <FolderBrowser disabled={busy} start={lastFolder} onPick={pick} />
                </>
              ) : (
                <FolderPickerRow path={source} placeholder={PLACEHOLDER} disabled={busy} onPick={() => void pickNative()} />
              )}
            </TripSection>
            <TripSection k="summary" label="What travels">
              <Summary plan={plan} workspace={workspace} />
            </TripSection>
            {plan !== null && plan.agents.length > 0 ? (
              <TripSection k="agents" label="Sessions">
                <Agents agents={plan.agents} ticked={tickedAgents} disabled={phase !== "idle"} onToggle={toggleAgent} />
              </TripSection>
            ) : null}
            {plan !== null && plan.secrets.length > 0 ? (
              <TripSection k="secrets" label="Secrets">
                <Secrets secrets={plan.secrets} ticked={ticked} disabled={phase !== "idle"} onToggle={toggle} />
              </TripSection>
            ) : null}
            <TripStatus tone={said.tone} fraction={progress?.fraction ?? null}>
              {said.words}
            </TripStatus>
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

function Summary({ plan, workspace }: { plan: ProjectPlan | null; workspace: WorkspaceView }) {
  const skippedTitle = plan?.skipped.map(s => `${s.path}: ${s.note}`).join("\n");
  return (
    <div className="flex flex-col">
      <FactRow label="Repository" k="repository" mono={false}>
        {plan === null ? "" : repoLine(plan.repo)}
      </FactRow>
      <FactRow label="Files" k="files">
        {plan === null ? "" : `${count(plan.files, "file")} · ${fmtBytes(plan.bytes)}`}
      </FactRow>
      <CachesRow excluded={plan?.excluded ?? null} />
      <FactRow label="Not carried" k="skipped" {...(skippedTitle !== undefined && skippedTitle !== "" ? { title: skippedTitle } : {})}>
        {plan === null ? "" : plan.skipped.length === 0 ? "none" : count(plan.skipped.length, "path")}
      </FactRow>
      <FactRow label="Lands at" k="dest">
        {plan === null ? "" : importDest(plan.source, workspace)}
      </FactRow>
    </div>
  );
}

function Agents({ agents, ticked, disabled, onToggle }: { agents: readonly ProjectAgent[]; ticked: ReadonlySet<string>; disabled: boolean; onToggle: (agent: string, on: boolean) => void }) {
  return (
    <>
      <ul className="flex flex-col">
        {agents.map(a => (
          <ConsentRow key={a.agent} label={a.name} mono={false} checked={ticked.has(a.agent)} disabled={disabled || !canTravel(a)} onToggle={on => onToggle(a.agent, on)}>
            <span data-k="state" className="ml-auto min-w-0 truncate font-mono text-[11px] tabular-nums text-muted-foreground" title={agentState(a)}>
              {agentState(a)}
            </span>
          </ConsentRow>
        ))}
      </ul>
      <p className="text-[11px] leading-4 text-muted-foreground">{SESSIONS_NOTE}</p>
    </>
  );
}

function Secrets({ secrets, ticked, disabled, onToggle }: { secrets: readonly ProjectSecret[]; ticked: ReadonlySet<string>; disabled: boolean; onToggle: (path: string, on: boolean) => void }) {
  return (
    <>
      <p className="text-[11px] leading-4 text-muted-foreground">{secretsNote(secrets.length)}</p>
      <ul className="flex flex-col">
        {secrets.map(s => {
          const on = ticked.has(s.path);
          const offer = secretOffer(s, on);
          return (
            <ConsentRow key={s.path} label={s.path} mono checked={on} disabled={disabled} title={`${s.path}: ${secretSignalsLine(s)}`} onToggle={next => onToggle(s.path, next)}>
              <span data-k="offer" className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={offer.full}>
                {offer.short}
              </span>
            </ConsentRow>
          );
        })}
      </ul>
    </>
  );
}
