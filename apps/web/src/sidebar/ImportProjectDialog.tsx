// SPDX-License-Identifier: AGPL-3.0-only
// Importing a folder on this Mac into a workspace: one container of quiet
// sections, the folder, what travels, the agents whose sessions go with it
// and the files that look like secrets, each a section only when the plan
// has rows for it; one action starts the import and the runtime's events
// read in the one slot above the footer that was empty until then. The
// desktop shell gives the folder as a picker row; a browser tab browses the
// host's own folders under the app's one folder field, which reads the path a
// moment after the typing stops and on Enter at once, so the field, the browser
// and the summary are all about one folder. The path shows as the person picked
// it; the plan speaks in realpaths, so the destination and the events are
// matched on that. A consent is for the plan the person read: the plan and the
// refusal are both kept with the path they are about, so editing the path shows
// neither until that folder is read.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fmtBytes, importDest, importIntoLine, importRequest, repoLine, secretSignalsLine, secretsNote, SESSIONS_NOTE, type ProjectAgent, type ProjectImportEvent, type ProjectImportResult, type ProjectPlan, type ProjectSecret, type WorkspaceView } from "@wsp/protocol";
import { CLIENT_CANNOT_IMPORT } from "../actions/format.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { FolderPathField, useFolderPick, type FolderRefusal } from "../files/FolderPathField.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { cn, errorText } from "../lib/utils.js";
import type { ProtocolEvent } from "../protocol/client.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { FACT } from "../settings/format.js";
import { FolderBrowser } from "./FolderBrowser.js";
import { agentState, canTravel, defaultAgents, defaultConsent, importProgress, isImportOf, landedLine, secretOffer } from "./importProject.js";
import { useLastFolderParent, useLastFolderStore } from "./lastFolderStore.js";
import { count, refusalOf, slotWords, type Refusal } from "./projectTrip.js";
import { CachesRow, ConsentRow, FactRow, FolderPickerRow, TripSection, TripStatus } from "./ProjectTripRows.js";

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
/** How long the typing rests before the folder is read. Long enough that a path is not read letter by letter on its
 * way in, short enough that a person who has stopped typing is not left looking at a summary of nothing. */
const READ_AFTER_TYPING_MS = 500;
/** What the footer says about the key that reads the folder without waiting for that rest. */
const ENTER_READS = "\u21b5 reads the folder";
/** Why Import cannot be pressed yet, in the slot under the field it waits on, where every held keycap's reason is
 * written; it goes the moment a folder is read, and a refusal takes the slot before it. */
const PATH_FIRST = "type the folder's path first";
/** Why there is no system chooser here, which a person who has used the desktop app looks for first. */
const NO_CHOOSER_HERE = "A browser tab cannot open a chooser: type the path, or walk to the folder below.";
/** What to do about a folder this computer would not read, the second half of the refusal under the field. */
const FOLDER_FIX = "Check the path, or pick another folder.";

/** The host's own reason as a refusal's first half; it ends its sentences without a stop and the fix follows it. */
const stopped = (said: string): string => (said.endsWith(".") ? said : `${said}.`);

export function ImportProjectDialog({ workspace, initialSource, onClose }: { workspace: WorkspaceView; initialSource?: string; onClose: () => void }) {
  const api = useStore(s => s.api);
  const landProject = useStore(s => s.landProject);
  const bridge = desktopBridge()?.pickFolder;
  const remember = useLastFolderStore(s => s.remember);
  const lastFolder = useLastFolderParent();
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [tickedAgents, setTickedAgents] = useState<ReadonlySet<string>>(new Set());
  const [events, setEvents] = useState<ProjectImportEvent[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ProjectImportResult | null>(null);
  // The import's own refusal, kept with the path it was raised for so it goes when the path is edited away.
  const [refused, setRefused] = useState<{ folder: string; refusal: Refusal } | null>(null);
  const sent = useRef<Sent>({ source: "", plan: null });

  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if (e.type === "project.import" && isImportOf(e, workspace.id, sent.current.source, sent.current.plan)) setEvents(prev => [...prev, e]);
    },
    [workspace.id],
  );
  useProtocolEvents(onEvent);

  const read = useCallback(
    async (folder: string): Promise<FolderRefusal | null> => {
      if (api?.planProject === undefined) return null;
      setRefused(null);
      setPlanned(null);
      setEvents([]);
      setResult(null);
      setPhase("idle");
      try {
        const next = await api.planProject(folder);
        setPlanned({ folder, plan: next });
        setTicked(defaultConsent(next.secrets));
        setTickedAgents(defaultAgents(next.agents));
        return null;
      } catch (e) {
        return { said: stopped(errorText(e)), fix: FOLDER_FIX };
      }
    },
    [api],
  );
  const hold = useFolderPick(read);
  const { submit } = hold;
  const source = hold.path;
  // The plan is the one read for the path the field holds; another path shows none until it is read.
  const plan = planned !== null && planned.folder === source ? planned.plan : null;
  const refusal = refused !== null && refused.folder === source ? refused.refusal : null;

  useEffect(() => {
    if (initialSource !== undefined) void submit(initialSource);
  }, [initialSource, submit]);

  // The folder is read a moment after the typing stops, so the browser and the summary under the field follow the
  // path in it without a key being pressed; Enter reads it at once. A path the folder already read starts with is
  // one the person is still shaping, the folder already read included: reading it would walk a parent folder whole
  // on the way to the one they mean. Enter reads such a path anyway, since it goes straight to the read.
  useEffect(() => {
    const folder = source.trim();
    if (folder === "" || hold.applied.startsWith(folder)) return;
    const timer = setTimeout(() => void submit(folder), READ_AFTER_TYPING_MS);
    return () => clearTimeout(timer);
  }, [source, hold.applied, submit]);

  const pickNative = async (): Promise<void> => {
    if (bridge === undefined) return;
    const picked = await bridge();
    if (picked !== undefined) await submit(picked);
  };

  const start = async (replace: boolean): Promise<void> => {
    if (plan === null || api?.importProject === undefined) return;
    sent.current = { source, plan };
    setPhase("importing");
    setEvents([]);
    setRefused(null);
    try {
      const landed = await api.importProject({ workspaceId: workspace.id, ...importRequest(plan, source, ticked, tickedAgents, replace, workspace) });
      setResult(landed);
      landProject(workspace.id, landed.project);
      setPhase("done");
      remember(source);
    } catch (e) {
      setRefused({ folder: source, refusal: refusalOf(e) });
      setPhase("idle");
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

  const busy = hold.reading || phase === "importing";
  // Only an import under way takes the folder field and the list away. A read does not: it starts on its own after
  // a pause now, and a field that goes dead mid-path drops the focus and every letter until the read comes back.
  const sending = phase === "importing";
  // Import waits on a folder this host has read; being busy with one is not waiting, so it keeps its own variant.
  const waiting = phase !== "done" && (plan === null || api?.importProject === undefined);
  // What the footer says under the keys: why nothing can be imported from this window at all, which no field waits
  // on and so belongs here, else the key that reads a folder without waiting for the typing to rest, which only a
  // window typing a path has.
  const footNote = api?.importProject === undefined ? CLIENT_CANNOT_IMPORT : bridge === undefined ? ENTER_READS : null;
  // Why Import waits, in the slot under the field it waits on and on the screen before any click; a read under way
  // says so in the status slot instead, and a folder that has been read leaves the slot to its refusals.
  const pathWaiting = plan === null && !hold.reading ? PATH_FIRST : undefined;
  const primary = phase === "done" ? "Done" : refusal?.exists ? "Replace and import" : "Import";
  const progress = phase === "idle" ? null : importProgress(events, workspace.name);
  // Where there is no field there is no slot under one, so a read this computer refused keeps the status line, in
  // the same two halves the slot would have drawn.
  const readRefusal = bridge !== undefined && hold.refusal !== null ? { message: `${hold.refusal.said} ${hold.refusal.fix}`, exists: false } : null;
  const said = slotWords({ refusal: refusal ?? readRefusal, landed: result === null ? null : landedLine(result, sent.current.source, workspace.name), progress, idle: hold.reading ? "Reading the folder." : "" });

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
                  <p className="text-[13px] leading-5 text-muted-foreground" data-k="no-chooser">
                    {NO_CHOOSER_HERE}
                  </p>
                  <FolderPathField id="import-source" placeholder={PLACEHOLDER} hold={hold} waiting={pathWaiting} disabled={sending} autoFocus={initialSource === undefined} />
                  <FolderBrowser disabled={sending} start={hold.applied === "" ? lastFolder : hold.applied} onPick={dir => void submit(dir)} />
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
            {phase === "idle" && footNote !== null ? (
              <span className={cn(FACT, "mr-auto self-center")} data-k="foot-note">
                {footNote}
              </span>
            ) : null}
            {phase === "done" ? null : (
              <Button type="button" variant="outline" disabled={phase === "importing"} onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              type="button"
              data-k="import"
              held={waiting}
              disabled={busy}
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

/** A fact this dialog will hold once a folder has been read, while it waits for one: a bar in the value's slot, so
 * the five rows read as facts on their way rather than as five blank labels. */
const Waiting = (): ReactNode => <Skeleton className="inline-block h-3 w-24 align-middle" />;

function Summary({ plan, workspace }: { plan: ProjectPlan | null; workspace: WorkspaceView }) {
  const skippedTitle = plan?.skipped.map(s => `${s.path}: ${s.note}`).join("\n");
  return (
    <div className="flex flex-col">
      <FactRow label="Repository" k="repository" mono={false}>
        {plan === null ? <Waiting /> : repoLine(plan.repo)}
      </FactRow>
      <FactRow label="Files" k="files">
        {plan === null ? <Waiting /> : `${count(plan.files, "file")} · ${fmtBytes(plan.bytes)}`}
      </FactRow>
      <CachesRow excluded={plan?.excluded ?? null} idle={<Waiting />} />
      <FactRow label="Not carried" k="skipped" {...(skippedTitle !== undefined && skippedTitle !== "" ? { title: skippedTitle } : {})}>
        {plan === null ? <Waiting /> : plan.skipped.length === 0 ? "none" : count(plan.skipped.length, "path")}
      </FactRow>
      <FactRow label="Lands at" k="dest">
        {plan === null ? <Waiting /> : importDest(plan.source, workspace)}
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
