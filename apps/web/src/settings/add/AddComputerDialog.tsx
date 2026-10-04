// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer as one dialog, 560 px wide and one height across its steps:
// the header carries the step's name, a line only where the rows do not say
// it, and the step's place in the run as a quiet mono figure; the body is the
// step's rows in the settings list grammar; the foot is the saved line once a
// choice is kept, then Back and the primary. The running view is the same
// rows in the order they were chosen, a row that needs the person opening
// under itself with its acts. When every row is done, Next opens the ready
// page: a wash of the theme's hero ink from the top edge behind the box's name
// and the one act.
import { CheckIcon, ExternalLinkIcon, ListChecksIcon, ServerIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtBytes, fmtDuration, HERE_PLACE_ID, hereName, recipeCounts, recipeSummary, type PlaceSetupStep, type PlaceView, type ProjectIcon, type RecipeFile, type RecipeOptions, type SshHostSuggestion } from "@wsp/protocol";
import { agentName } from "@wsp/catalog";
import { AddButton } from "../../components/ui/add-button.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { RadioGroup } from "../../components/ui/radio-group.js";
import { desktopBridge } from "../../lib/desktopShell.js";
import { cn } from "../../lib/utils.js";
import { addNotice } from "../../notices/store.js";
import { useStore } from "../../protocol/store.js";
import { failureOf, type Failure } from "../../protocol/failure.js";
import { PROJECT_GLYPHS } from "../../projects/look.js";
import { IconSelect } from "../../projects/LookPicker.js";
import { useAdds } from "../adds.js";
import { ComputerGlyph } from "../ComputerGlyph.js";
import { ADD_COMPUTER_WORDS, FACT } from "../format.js";
import { Grid, GridHead } from "../grid.js";
import { NOTE, ROW_FIELD } from "../layout.js";
import { placeName } from "../places.js";
import { readRecipes, useRecipes } from "../recipesStore.js";
import { Card, Line } from "../rows.js";
import { CopyRow, DeviceCode, RefusalSlot } from "../sheetParts.js";
import { STEP_TITLES, askedHostKey, closeAdd, connect, firstPick, go, openSetup, readOptions, retrySetup, setPicks, skipRow, setSaveAs, setUp, stepsFor, tooBig, useAddFlow, weigh, type AddStep } from "./addFlow.js";
import { everything, folderKey, githubPick, noPicks } from "./choices.js";
import { AgentsPicks, Choice, ClisPicks, GitHubPicks, OtherPicks, PluginsPicks, ProjectsPicks, ServersPicks, SkillsPicks, type FolderOption } from "./PickLists.js";
import { PickLine, PickRow } from "./PickRow.js";
import { checkRows, runningMs, setupCount, setupRows, setupStanding, stepOutput, type StepLine } from "./setup.js";
import { RetryActs, SkipAct, StepRow } from "./StepRow.js";

const GLYPH = "size-4 text-foreground/80";


const sshLogin = (host: SshHostSuggestion): string => [host.user, host.hostName ?? host.alias].filter(Boolean).join("@");

function WhereStep({ address, hostKey, hosts, hostsRefused, onPick }: { address: string; hostKey: string | undefined; hosts: readonly SshHostSuggestion[]; hostsRefused: Failure | null; onPick: (alias: string) => void }) {
  const picked = hosts.find(host => host.alias === address.trim())?.alias ?? "";
  return (
    <>
      <Input data-k="where-field" aria-label="Address" nativeInput autoFocus autoComplete="off" spellCheck={false} autoCapitalize="off" value={address} placeholder="user@host or an ssh alias" onChange={e => useAddFlow.setState({ address: e.target.value })} size="lg" className="font-mono" />
      {hostKey !== undefined ? (
        <div className="flex flex-col gap-2">
          <p className={NOTE}>{address.trim()}'s host key is new to {hereName(useStore.getState().places)}.</p>
          <CopyRow k="host-key" value={hostKey} />
        </div>
      ) : hostsRefused !== null ? (
        <RefusalSlot k="ssh-hosts-refused" said={ADD_COMPUTER_WORDS.hostsNotRead(hostsRefused.said)} {...(hostsRefused.fix === undefined ? {} : { fix: hostsRefused.fix })} />
      ) : hosts.length === 0 ? null : (
        <RadioGroup value={picked} onValueChange={next => onPick(String(next))} className="gap-0">
          <Grid id="ssh-hosts" head={<GridHead cells={[{ word: ADD_COMPUTER_WORDS.suggested }]} />}>
            {hosts.map(host => (
              <Choice key={host.alias} id={host.alias} picked={picked === "" || picked === host.alias} glyph={<ServerIcon aria-hidden className={GLYPH} />} name={host.alias} fact={sshLogin(host)} />
            ))}
          </Grid>
        </RadioGroup>
      )}
    </>
  );
}

function ChecksStep({ rows, onAgain }: { rows: readonly StepLine[]; onAgain: () => void }) {
  return (
    <Grid id="checks">
      {rows.map(row => (
        <StepRow key={row.id} row={row} {...(row.state === "failed" ? { acts: <Button size="xs" variant="outline" data-k="try-again" onClick={onAgain}>Try again</Button> } : {})} />
      ))}
    </Grid>
  );
}

function StartFromStep({ here, picks, options, onPick, from }: { here: string; picks: RecipeFile; options: RecipeOptions; onPick: (from: string, next: RecipeFile) => void; from: string }) {
  const recipes = useRecipes(s => s.recipes) ?? [];
  const looks = useStore(s => s.preferences.recipeLook);
  const projects = useHereProjects();
  const projectLooks = useStore(s => s.preferences.projectLook);
  const hereRow = useStore(s => s.places.find(p => p.id === HERE_PLACE_ID));
  const all = everything(picks.name, options, projects, projectLooks);
  return (
    <RadioGroup
      value={from}
      onValueChange={next => {
        const id = String(next);
        const recipe = recipes.find(r => r.slug === id);
        onPick(id, id === "here" ? all : id === "none" ? noPicks(picks.name) : recipe === undefined ? picks : { ...recipe.file, name: picks.name });
      }}
      className="gap-0"
    >
      <Grid id="start-from">
        <Choice id="here" picked={from === "here"} glyph={hereRow === undefined ? <ListChecksIcon aria-hidden className={GLYPH} /> : <ComputerGlyph place={hereRow} className={GLYPH} />} name={`Everything on ${here}`} note={`${recipeSummary(all)}.`} />
        {recipes.map(recipe => {
          const Glyph = PROJECT_GLYPHS[looks?.[recipe.slug]?.icon ?? "folder"];
          return <Choice key={recipe.slug} id={recipe.slug} picked={from === recipe.slug} glyph={<Glyph aria-hidden className={GLYPH} />} name={recipe.name} note={recipe.summary} {...(recipe.machines.length === 0 ? {} : { fact: `on ${recipe.machines.join(", ")}` })} />;
        })}
        <Choice id="none" picked={from === "none"} glyph={<ListChecksIcon aria-hidden className={GLYPH} />} name="Pick each step" note="Nothing ticked." />
      </Grid>
    </RadioGroup>
  );
}

/** The projects on the computer running the host, which is where folders are imported from. */
function useHereProjects() {
  const projects = useStore(s => s.projects);
  return useMemo(() => projects.filter(p => p.computer === HERE_PLACE_ID), [projects]);
}

/** What the host read of a folder of the computer running it, by its path: its size, whether it is private, and the
 * commits no remote holds. */
const folderFacts = (facts: RecipeOptions["folders"], path: string): Pick<FolderOption, "bytes" | "private" | "unpushed"> => {
  const fact = facts?.find(f => f.path === path);
  return { ...(fact?.bytes === undefined ? {} : { bytes: fact.bytes }), ...(fact?.private === undefined ? {} : { private: fact.private }), ...(fact?.unpushed === undefined ? {} : { unpushed: fact.unpushed }) };
};

function ProjectsStep({ picks, box, boxId, facts, onChange }: { picks: RecipeFile; box: string; boxId: string; facts: RecipeOptions["folders"]; onChange: (next: RecipeFile) => void }) {
  const here = useHereProjects();
  const looks = useStore(s => s.preferences.projectLook);
  const onBox = useStore(s => s.projects).filter(p => p.computer === boxId);
  const [added, setAdded] = useState<readonly FolderOption[]>([]);
  // A folder already in the picks that is no project here is one the person picked: it stands at the top.
  const picked: FolderOption[] = Object.entries(picks.folders)
    .filter(([key]) => !here.some(p => folderKey(p.name) === key) && !added.some(f => f.key === key))
    .map(([key, row]) => ({ key, name: row.name ?? key, path: row.from, icon: row.icon ?? "folder", hue: row.hue ?? "neutral", ...folderFacts(facts, row.from) }));
  const folders: FolderOption[] = [...added, ...picked, ...here.map(p => ({ key: folderKey(p.name), name: p.name, path: p.path, remote: p.remote, icon: looks[p.id]?.icon ?? "folder", hue: looks[p.id]?.hue ?? "neutral", ...folderFacts(facts, p.path) }))];
  const pick = desktopBridge()?.pickFolder;
  const addFolder = async (): Promise<void> => {
    const path = await pick?.();
    if (path === undefined) return;
    const name = path.split("/").filter(Boolean).at(-1) ?? path;
    const folder: FolderOption = { key: folderKey(name), name, path, icon: "folder", hue: "neutral" };
    setAdded(rows => [folder, ...rows.filter(r => r.key !== folder.key)]);
    onChange({ ...picks, folders: { ...picks.folders, [folder.key]: { from: path, name, icon: "folder", hue: "neutral", keep: [] } } });
  };
  return (
    <>
      <ProjectsPicks picks={picks} onChange={onChange} box={box} folders={folders} taken={name => onBox.some(p => p.name === name)} />
      {pick === undefined ? null : (
        <div className="flex">
          <AddButton data-k="add-folder" onClick={() => void addFolder()}>
            Add a folder…
          </AddButton>
        </div>
      )}
    </>
  );
}

/** A name the computer already has a project by, among the folders the picks import. */
const nameTaken = (picks: RecipeFile, boxProjects: readonly { name: string }[]): boolean => Object.values(picks.folders).some(f => boxProjects.some(p => p.name === (f.name ?? "")));

const names = (table: Record<string, unknown>): string => Object.keys(table).join(", ");

function SummaryStep({ picks, box, place, here, recipeIcon }: { picks: RecipeFile; box: string; place: PlaceView | undefined; here: string; recipeIcon: ProjectIcon }) {
  const saveAs = useAddFlow(s => s.saveAs);
  const estimate = useAddFlow(s => s.estimate);
  const free = estimate?.freeBytes ?? place?.diskFreeBytes;
  const short = tooBig(estimate);
  const counts = recipeCounts(picks);
  const github = { vault: `Token from ${here}`, machine: `Sign in on ${box}`, skip: ADD_COMPUTER_WORDS.skipForNow }[githubPick(picks)];
  const lines: [string, string][] = [
    ["Agents", Object.keys(picks.agents).map(agentName).join(", ")],
    ["MCP servers", names(picks.mcp)],
    ["CLIs", names(picks.clis)],
    ["Skills", String(counts.skills)],
    ["Plugins", String(counts.plugins)],
    ["GitHub", github],
    ["Projects", Object.values(picks.folders).map(f => f.name ?? f.from).join(", ")],
    ["Other config", [picks.configs.git === undefined ? undefined : "git", picks.configs.shell === undefined ? undefined : "shell"].filter(Boolean).join(", ")],
  ];
  const Glyph = PROJECT_GLYPHS[recipeIcon];
  return (
    <>
      <Card id="summary-lines">
        {lines.map(([label, value]) => (
          <Line key={label} id={label} label={label} value={value === "" || value === "0" ? "None" : value} valueClass="fact" />
        ))}
        {estimate === null && free === undefined ? null : (
          <Line
            id="disk"
            label={`Disk on ${box}`}
            control={
              <span
                data-k="disk"
                data-short={short}
                {...(estimate === null || estimate.unmeasured === 0 ? {} : { title: ADD_COMPUTER_WORDS.unmeasured(estimate.unmeasured) })}
                className={cn("text-[13px] tabular-nums sm:text-right", short ? "text-destructive-foreground" : "text-muted-foreground")}
              >
                {estimate === null ? `${fmtBytes(free!)} free` : free === undefined ? `${fmtBytes(estimate.neededBytes)} needed` : ADD_COMPUTER_WORDS.diskLine(fmtBytes(estimate.neededBytes), fmtBytes(free))}
              </span>
            }
          />
        )}
      </Card>
      {short ? <RefusalSlot k="disk-short" {...ADD_COMPUTER_WORDS.diskShort(box, fmtBytes(free!), fmtBytes(estimate!.neededBytes))} /> : null}
      <Card id="save-recipe">
        <PickRow id="save" checked={saveAs.on} onCheckedChange={on => setSaveAs({ on })} glyph={<Glyph aria-hidden className={GLYPH} />} name="Save as a recipe" note="The next box starts from these picks.">
          {saveAs.on ? (
            <>
              <PickLine label="Name">
                <Input data-k="recipe-name" aria-label="Recipe name" value={saveAs.name} onChange={e => setSaveAs({ name: e.target.value })} className={cn(ROW_FIELD, "w-44 max-sm:w-36")} />
              </PickLine>
              <PickLine label="Icon">
                <IconSelect icon={saveAs.icon} hue="neutral" onChange={icon => setSaveAs({ icon })} />
              </PickLine>
            </>
          ) : null}
        </PickRow>
      </Card>
    </>
  );
}

/** A sign-in that waits on the person: the code, the tab opened again, Skip for now, and where it can be finished
 * later. A wait that ran out says so and is run again by Retry. */
function WaitBlock({ row, onRetry, onSkip, busy }: { row: StepLine; onRetry: () => void; onSkip: () => void; busy: boolean }) {
  const skip = <SkipAct word={ADD_COMPUTER_WORDS.skipForNow} onSkip={onSkip} busy={busy} />;
  const wait = row.wait!;
  if (wait.state === "expired") {
    return (
      <>
        <p data-k="step-refusal" className="text-[13px] leading-[18px] text-destructive-foreground">
          The sign-in page ran out.<span className="text-foreground"> Retry opens a fresh one.</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <RetryActs onRetry={onRetry} busy={busy} />
          {skip}
        </div>
      </>
    );
  }
  return (
    <>
      <div data-sign-in-line className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
        {wait.code === undefined ? null : <DeviceCode code={wait.code} />}
        {wait.url === undefined ? null : (
          <Button size="xs" variant="outline" data-k="open-tab" onClick={() => void window.open(wait.url, "_blank", "noopener,noreferrer")}>
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            Open the tab again
          </Button>
        )}
        {skip}
      </div>
      <p className={NOTE}>{ADD_COMPUTER_WORDS.signInLater}</p>
    </>
  );
}

/** The steps of a setup with what each row asks: Retry where a row did not land, Skip where it is an item the host can
 * set aside, the wait where a sign-in does. */
export function SetupList({ place, id = "setup", rows = setupRows(place, placeName(place)) }: { place: PlaceView; id?: string; rows?: readonly StepLine[] }) {
  const api = useStore(s => s.api);
  const [refused, setRefused] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = (run: () => Promise<Failure | null>): void => {
    setBusy(true);
    void run().then(failure => {
      setBusy(false);
      setRefused(failure);
    });
  };
  const retry = (): void => ask(() => retrySetup(api, place.id));
  const skip = (row: string) => (): void => ask(() => skipRow(api, place.id, row));
  const acts = (row: StepLine): ReactNode =>
    row.state !== "failed" || row.wait !== undefined ? undefined : (
      <>
        <RetryActs onRetry={retry} busy={busy} />
        {row.sub === true ? <SkipAct word={ADD_COMPUTER_WORDS.skip} onSkip={skip(row.id)} busy={busy} /> : null}
      </>
    );
  return (
    <>
      <Grid id={id}>
        {rows.map(row => (
          <StepRow key={row.id} row={row} acts={acts(row)}>
            {row.wait === undefined ? undefined : <WaitBlock row={row} onRetry={retry} onSkip={skip(row.id)} busy={busy} />}
          </StepRow>
        ))}
      </Grid>
      {refused === null ? null : <RefusalSlot k="retry-refused" said={refused.said} {...(refused.fix === undefined ? {} : { fix: refused.fix })} />}
    </>
  );
}

/** How often the steps running are read off the box's setup log: one tail of the log a read, for every step at once. */
const OUTPUT_EVERY_MS = 3000;

/** The time now, moved once a second while `on`: one interval for every row that ticks, never one per row. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** The last line of output of each step running, read when the steps running change and on a timer while any runs,
 * never on a render; a read still out when the next is due is not doubled. It stands behind the row on hover: the
 * row's own note is the sentence its picks make. */
function useStepOutput(placeId: string, running: string): Partial<Record<PlaceSetupStep, string>> {
  const api = useStore(s => s.api);
  const [out, setOut] = useState<Partial<Record<PlaceSetupStep, string>>>({});
  useEffect(() => {
    const read = api?.placesSetupLog;
    if (running === "" || read === undefined) return;
    let live = true;
    let asking = false;
    const tail = (): void => {
      if (asking) return;
      asking = true;
      void read(placeId).then(
        lines => {
          asking = false;
          if (!live) return;
          const next = stepOutput(lines);
          setOut(was => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
        },
        () => {
          asking = false;
        },
      );
    };
    tail();
    const timer = setInterval(tail, OUTPUT_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, placeId, running]);
  return out;
}

function RunningView({ place }: { place: PlaceView }) {
  const drawn = setupRows(place, placeName(place));
  const working = drawn.filter(row => row.state === "working").map(row => row.id);
  const output = useStepOutput(place.id, working.join(" "));
  const now = useNow(working.length > 0);
  const rows = drawn.map(row => {
    if (row.state !== "working") return row;
    const said = output[row.id as PlaceSetupStep];
    const ms = runningMs(place.setup, row.id, now);
    return { ...row, ticking: true as const, ...(ms === undefined ? {} : { ms }), ...(said === undefined ? {} : { output: said }) };
  });
  const asks = rows.find(row => row.state === "needs-you" || row.state === "failed")?.id;
  const shown = useRef(false);
  // The list opens on the first row that waits on the person, once, when it first appears, so a long run never hides
  // the one act it asks for.
  useEffect(() => {
    if (asks === undefined || shown.current) return;
    shown.current = true;
    document.querySelector(`[data-add-computer] [data-step-row="${CSS.escape(asks)}"]`)?.scrollIntoView({ block: "center" });
  }, [asks]);
  return <SetupList place={place} rows={rows} />;
}

/** The page after every row is done: one static wash in the theme's hero ink falling from the dialog's top edge, the
 * box's glyph and name, what landed, and the one act. */
function ReadyPage({ place, onStart, onClose }: { place: PlaceView; onStart: () => void; onClose: () => void }) {
  const name = placeName(place);
  return (
    <div data-k="ready-page" className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-xl px-6 py-12 text-center">
      <span aria-hidden data-k="ready-wash" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-1/2 bg-[radial-gradient(70%_100%_at_50%_0%,color-mix(in_srgb,var(--hero-field)_32%,transparent),transparent_100%)]" />
      <span className="flex size-12 items-center justify-center rounded-lg border border-border bg-foreground/[0.04]">
        <ComputerGlyph place={place} className="size-6 text-foreground/80" />
      </span>
      <h2 data-k="ready-title" className="mt-5 text-2xl/8 font-medium tracking-[-0.01em] text-foreground">
        {name} is ready
      </h2>
      {place.picks === undefined ? null : <p className={cn(NOTE, "mt-1.5")}>{recipeSummary(place.picks)}.</p>}
      <div className="mt-7 flex items-center gap-2">
        <Button data-k="start-task" onClick={onStart}>
          Start a task here
        </Button>
        <Button variant="ghost" data-k="ready-close" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** The foot's left: the auto-save check, drawn in again on every save, and the one line. Keyed on the save count so a
 * landed save remounts it and its stroke draws in once more; nothing moves at rest. */
function SavedLine() {
  const n = useAddFlow(s => s.saves);
  return (
    <span data-k="saved" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <CheckIcon key={n} aria-hidden className="autosave-check size-3.5 shrink-0" />
      {ADD_COMPUTER_WORDS.saved}
    </span>
  );
}

/** The dialog's foot: the saved line at the left once a choice is kept, the acts at the right. Under 640 px the acts
 * stack with the primary on top and the line stands under them. */
function Foot({ left, children }: { left: ReactNode; children: ReactNode }) {
  return (
    <div data-slot="dialog-footer" className="flex flex-col-reverse gap-2 px-5 pt-3 pb-4 sm:flex-row sm:items-center sm:justify-end">
      <span className="flex min-h-5 items-center max-sm:justify-center sm:me-auto">{left}</span>
      {children}
    </div>
  );
}

const PICK_STEPS: ReadonlySet<AddStep> = new Set(["startfrom", "agents", "mcp", "clis", "skills", "plugins", "github", "projects", "other", "summary"]);

/** Whether picks hold nothing at all, which is where a first pick step fills them with everything. */
const empty = (picks: RecipeFile | null): boolean => picks === null || Object.values(recipeCounts(picks)).every(n => n === 0);

export function AddComputerDialog() {
  const flow = useAddFlow();
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const projects = useStore(s => s.projects);
  const projectLooks = useStore(s => s.preferences.projectLook);
  const setPreferences = useStore(s => s.setPreferences);
  const recipes = useRecipes(s => s.recipes);
  const job = useAdds(s => (flow.addId === null ? undefined : s.jobs[flow.addId]));
  const [hosts, setHosts] = useState<SshHostSuggestion[]>([]);
  const [hostsRefused, setHostsRefused] = useState<Failure | null>(null);
  const here = hereName(places);
  const place = flow.placeId === null ? undefined : places.find(p => p.id === flow.placeId);
  const box = place === undefined ? flow.address.trim() : placeName(place);
  const steps = stepsFor(recipes?.length ?? 0);

  useEffect(() => {
    if (!flow.open || api === null) return;
    readRecipes(api);
    readOptions(api);
    void api.sshHosts?.().then(
      found => {
        setHosts(found);
        setHostsRefused(null);
      },
      (e: unknown) => {
        const failure = failureOf(e);
        setHosts([]);
        // A socket that may not ask is not a fault, and a lost one is said by the banner.
        setHostsRefused(failure.kind === "ticket" || failure.disconnected ? null : failure);
      },
    );
  }, [flow.open, api]);

  // The computer joined: the add goes on to its picks, the pending add standing for it under the same id.
  useEffect(() => {
    if (job?.state === "done" && job.placeId !== undefined && flow.placeId === null) useAddFlow.setState({ placeId: job.placeId, pendingId: job.addId });
  }, [job?.state, job?.placeId, flow.placeId, job?.addId]);

  // The summary weighs the picks as they stand each time it opens, and again on any change to them.
  useEffect(() => {
    if (flow.step !== "summary" || api === null || flow.placeId === null || flow.picks === null) return;
    weigh(api, flow.placeId, flow.picks);
  }, [flow.step, api, flow.placeId, flow.picks]);

  // A first pick step with nothing picked starts from everything the computer running the host has, once.
  useEffect(() => {
    if (!PICK_STEPS.has(flow.step) || flow.options === null || flow.from !== "here" || flow.saves > 0 || !empty(flow.picks)) return;
    setPicks(api, everything(flow.picks?.name ?? box, flow.options, projects.filter(p => p.computer === HERE_PLACE_ID), projectLooks));
  }, [flow.step, flow.options, flow.from, flow.saves, flow.picks, api, box, projects, projectLooks]);

  if (!flow.open) return null;

  const keyAsked = flow.step === "checks" ? askedHostKey(job) : undefined;
  const view: AddStep | "hostkey" = keyAsked !== undefined ? "hostkey" : flow.step;
  const picks = flow.picks ?? noPicks(box);
  const change = (next: RecipeFile): void => setPicks(api, next);
  const close = (): void => {
    if (flow.step === "running" && place !== undefined && setupStanding(place) === "running") {
      const placeId = place.id;
      addNotice({ kind: "note", text: ADD_COMPUTER_WORDS.keepsGoing, where: box, action: { word: "Open", run: () => openSetup(placeId) } });
    }
    closeAdd();
  };
  const next = (): void => {
    const at = steps.indexOf(flow.step);
    const to = steps[at + 1];
    if (to !== undefined) go(to);
  };
  // The checks are this window's own install: a pending add opened again has none to go back to.
  const backTo = steps[steps.indexOf(flow.step) - 1];
  const canBack = backTo !== undefined && (backTo !== "checks" || flow.addId !== null);
  const back = (): void => {
    if (canBack) go(backTo);
  };
  const doConnect = (key?: string): void => {
    if (api === null || flow.address.trim() === "") return;
    connect(api, flow.address, key);
  };
  const startTask = (): void => {
    const project = projects.find(p => p.computer === flow.placeId);
    closeAdd();
    useStore.getState().closeSettings();
    if (project !== undefined) useStore.getState().openProjectHome(project.id);
  };

  const options = flow.options;
  const versions = places.find(p => p.id === HERE_PLACE_ID)?.agentVersions;
  const boxProjects = projects.filter(p => p.computer === flow.placeId);
  const optionsBody = (draw: (o: RecipeOptions) => ReactNode): ReactNode =>
    options !== null ? draw(options) : flow.optionsRefused !== null ? <RefusalSlot k="options-refused" said={flow.optionsRefused.said} {...(flow.optionsRefused.fix === undefined ? {} : { fix: flow.optionsRefused.fix })} /> : null;

  const body = (): ReactNode => {
    switch (view) {
      case "where":
        return <WhereStep address={flow.address} hostKey={undefined} hosts={hosts} hostsRefused={hostsRefused} onPick={alias => useAddFlow.setState({ address: alias })} />;
      case "hostkey":
        return <WhereStep address={flow.address} hostKey={keyAsked} hosts={[]} hostsRefused={null} onPick={() => {}} />;
      case "checks":
        return <ChecksStep rows={checkRows(job)} onAgain={() => go("where")} />;
      case "startfrom":
        return optionsBody(o => <StartFromStep here={here} picks={picks} options={o} from={flow.from} onPick={(from, next) => setPicks(api, next, from)} />);
      case "agents":
        return optionsBody(o => <AgentsPicks picks={picks} options={o} onChange={change} box={box} {...(versions === undefined ? {} : { versions })} />);
      case "mcp":
        return optionsBody(o => <ServersPicks picks={picks} options={o} onChange={change} box={box} />);
      case "clis":
        return optionsBody(o => <ClisPicks picks={picks} options={o} onChange={change} box={box} />);
      case "skills":
        return optionsBody(o => <SkillsPicks picks={picks} options={o} onChange={change} box={box} />);
      case "plugins":
        return optionsBody(o => <PluginsPicks picks={picks} options={o} onChange={change} box={box} />);
      case "github":
        return optionsBody(o => <GitHubPicks picks={picks} options={o} onChange={change} box={box} here={here} />);
      case "projects":
        return <ProjectsStep picks={picks} box={box} boxId={flow.placeId ?? ""} facts={options?.folders} onChange={change} />;
      case "other":
        return optionsBody(o => <OtherPicks picks={picks} options={o} onChange={change} box={box} />);
      case "summary":
        return (
          <>
            <SummaryStep picks={picks} box={box} place={place} here={here} recipeIcon={flow.saveAs.icon} />
            {flow.refused === null ? null : <RefusalSlot k="setup-refused" said={flow.refused.said} {...(flow.refused.fix === undefined ? {} : { fix: flow.refused.fix })} />}
          </>
        );
      default:
        return place === undefined ? null : <RunningView place={place} />;
    }
  };

  const standing = place === undefined ? "running" : setupStanding(place);
  const rows = place === undefined ? [] : setupRows(place, box);
  const head = ((): { title: string; line?: string } => {
    if (view === "where" || view === "hostkey") return { title: ADD_COMPUTER_WORDS.title, line: ADD_COMPUTER_WORDS.where };
    if (view !== "running" && view !== "ready") return { title: STEP_TITLES[view] };
    if (standing === "failed") return { title: `Setup on ${box} failed` };
    if (standing === "needs-you") return { title: `${box} needs you`, line: ADD_COMPUTER_WORDS.restDone };
    if (standing === "ready") {
      const took = place?.setup?.finishedAt === undefined ? undefined : Date.parse(place.setup.finishedAt) - Date.parse(place.setup.startedAt);
      return { title: `${box} is ready`, ...(took === undefined || !Number.isFinite(took) ? {} : { line: `Set up in ${fmtDuration(took)}.` }) };
    }
    return { title: `Setting up ${box}`, line: ADD_COMPUTER_WORDS.canClose };
  })();
  const figure = ((): { words: string; why: string } => {
    if (view === "running") {
      const { done, of } = setupCount(rows);
      return { words: `${done} of ${of} done`, why: `${done} of ${of} steps done` };
    }
    const at = steps.indexOf(view === "hostkey" ? "where" : view) + 1;
    return { words: `${at} of ${steps.length}`, why: `Step ${at} of ${steps.length}` };
  })();

  const backButton = canBack ? (
    <Button variant="outline" data-k="back" onClick={back}>
      Back
    </Button>
  ) : null;
  const primary = (word: string, run: () => void, held = false) => (
    <Button data-k="continue" held={held} onClick={run}>
      {word}
    </Button>
  );
  const closeButton = (
    <Button variant="outline" data-k="close" onClick={close}>
      Close
    </Button>
  );
  const foot = ((): ReactNode => {
    switch (view) {
      case "where":
        return (
          <>
            <Button variant="outline" data-k="cancel" onClick={close}>
              Cancel
            </Button>
            {primary("Connect", () => doConnect(), flow.address.trim() === "" || api?.addComputerOverSsh === undefined)}
          </>
        );
      case "hostkey":
        return (
          <>
            <Button variant="outline" data-k="cancel" onClick={close}>
              Cancel
            </Button>
            {primary("Trust and connect", () => doConnect(keyAsked))}
          </>
        );
      case "checks":
        return (
          <>
            {backButton}
            {primary("Continue", () => go(firstPick(recipes?.length ?? 0)), flow.placeId === null)}
          </>
        );
      case "projects":
        return (
          <>
            {backButton}
            {primary("Continue", next, nameTaken(picks, boxProjects))}
          </>
        );
      case "summary":
        return (
          <>
            {backButton}
            {primary(`Set up ${box}`, () => void (api === null ? undefined : setUp(api, (slug, icon) => void setPreferences({ recipeLook: { [slug]: { icon } } }))), place === undefined || empty(flow.picks) || flow.starting || tooBig(flow.estimate))}
          </>
        );
      case "running":
        return standing === "ready" ? (
          <>
            {closeButton}
            {primary("Next", () => go("ready"))}
          </>
        ) : (
          closeButton
        );
      default:
        return (
          <>
            {backButton}
            {primary("Continue", next)}
          </>
        );
    }
  })();
  const saved = PICK_STEPS.has(view as AddStep);

  return (
    <Dialog open onOpenChange={open => (open ? undefined : close())}>
      <DialogPopup data-add-computer={view} initialFocus={view === "where" || view === "hostkey" ? undefined : false} className="max-w-[560px] [--settings-inset:16px] sm:h-[640px]">
        {view === "ready" && place !== undefined ? (
          <>
            <DialogTitle className="sr-only">{head.title}</DialogTitle>
            <ReadyPage place={place} onStart={startTask} onClose={close} />
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="flex-row items-start justify-between gap-6 pb-3">
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle>{head.title}</DialogTitle>
                {head.line === undefined ? null : <DialogDescription>{head.line}</DialogDescription>}
              </div>
              <span data-k="progress" className={cn(FACT, "shrink-0 pt-0.5")} title={figure.why}>
                {figure.words}
              </span>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-5 pt-2 pb-5">{body()}</DialogPanel>
            <Foot left={saved ? <SavedLine /> : null}>{foot}</Foot>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}
