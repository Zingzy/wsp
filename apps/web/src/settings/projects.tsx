// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Projects: one row per project this wsp records, its source and
// the computer it lives on where that is not this one, opening the project's
// own page; and that page, which says the record's facts as lines, what a new
// workspace starts from as rows, and the one act on it. Remove is refused
// while a workspace stands on the project, in the runtime's own sentence,
// and otherwise asks first and lands the runtime's answer as the toast.
import { HueSelect, IconSelect } from "../projects/LookPicker.js";
import { ProjectGlyph } from "../projects/look.js";
import { GlyphFrame } from "./grid.js";
import { useEffect, useState } from "react";
import { agentName } from "@wsp/catalog";
import { ACCESS_CHOICES, HERE_PLACE_ID, accessRefusal, fmtBytes, plural, projectInUseRefusal, type AccessChoice, type ProjectLook, type ProjectOverridesPatch, type ProjectSource, type ProjectView, type ThreadDefaults } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, DANGER_BUTTON, NEUTRAL_RING } from "../components/ui/button.js";
import { AddButton } from "../components/ui/add-button.js";
import type { Api } from "../protocol/client.js";
import { placeNames, projectComputerWord } from "../sidebar/workspaceRows.js";
import { PROJECT_WORDS } from "../sidebar/words.js";
import { RefusalSlot } from "./sheetParts.js";
import { AGENTS_PAGE_WORDS, PROJECTS_WORDS, WHERE_WORDS } from "./format.js";
import { AgentChoice, defaultAgentOf, modelLabel, newThreadPicks } from "./agents.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { SELECT_WIDTH } from "./layout.js";
import { builtWhen } from "./image.js";
import { hereName, isProviderPlace, placeName } from "./places.js";
import { CARD_SURFACE, Card, Cards, HeadRow, Row, type SettingsCardData, type SettingsItem } from "./rows.js";
import { VALUE } from "./format.js";
import { cn } from "../lib/utils.js";
import { useSidebarProjects } from "../protocol/store.js";
import type { SettingsContext } from "./settingsContext.js";
import type { SettingsAt } from "./settingsStore.js";

/** The word for where a project comes from, by the kind of its source. */
export function sourceWord(source: ProjectSource): string {
  switch (source.kind) {
    case "folder":
      return source.path;
    case "git":
      return source.url;
    case "github":
    case "gitlab":
      return source.repo;
  }
}

/** The workspaces standing on a project, by name, which is what its removal is refused for. */
export const workspacesOn = (ctx: Pick<SettingsContext, "workspaces">, project: Pick<ProjectView, "id">): string[] => ctx.workspaces.filter(w => w.project.id === project.id).map(w => w.name);

/** The one line a remove says by the computer's kind, matching the runtime's three landings. */
export function removeLine(ctx: Pick<SettingsContext, "places">, project: Pick<ProjectView, "computer">): string {
  if (project.computer === HERE_PLACE_ID) return PROJECTS_WORDS.removeHere;
  const place = ctx.places.find(p => p.id === project.computer);
  if (place === undefined) return PROJECTS_WORDS.removeHere;
  return isProviderPlace(place) ? PROJECTS_WORDS.removeAtCloud(placeName(place)) : PROJECTS_WORDS.removeOnComputer(placeName(place));
}

/** The pages under Projects in the sidebar: one per project this wsp records, in the list's own order. */
export function projectSubPages(ctx: SettingsContext): { at: SettingsAt; name: string }[] {
  return ctx.projects.map(project => ({ at: { kind: "project", id: project.id }, name: project.name }));
}

export function projectsCards(ctx: SettingsContext): SettingsCardData[] {
  const named = placeNames(ctx.places);
  const under = (
    <AddButton data-k="add-project-button" onClick={ctx.openAddProject}>
      {PROJECTS_WORDS.add}
    </AddButton>
  );
  if (ctx.projectsRefused !== null) {
    const { said, fix } = ctx.projectsRefused;
    return [{ id: "projects", items: [], under: <><RefusalSlot k="projects-refused" said={PROJECT_WORDS.notRead(said)} {...(fix === undefined ? {} : { fix })} />{under}</> }];
  }
  if (ctx.projects.length === 0) {
    return [{ id: "projects", items: [{ kind: "line", id: "none", label: `${PROJECTS_WORDS.none} ${PROJECTS_WORDS.noneDescription}`, empty: true, attrs: { "data-k": "projects-none" } }], under }];
  }
  return [
    {
      id: "projects",
      items: ctx.projects.map(project => {
        const computer = projectComputerWord(project, named) ?? hereName(ctx.places);
        const count = workspacesOn(ctx, project).length;
        return {
          kind: "row" as const,
          id: project.id,
          title: project.name,
          lead: (
            <GlyphFrame>
              <ProjectGlyph projectId={project.id} />
            </GlyphFrame>
          ),
          description: [computer, sourceWord(project.source)],
          mono: true,
          // A project nothing stands on reads 0: the count is loaded, and a blank where a sibling reads 3 is a
          // fact nobody can tell from a fact that never arrived.
          word: String(count),
          wordClass: "fact" as const,
          open: () => ctx.go({ kind: "project", id: project.id }),
          attrs: { "data-project-row": project.id },
        };
      }),
      under,
    },
  ];
}

/** Remove a project: refused in the runtime's own sentence while a workspace stands on it, else asked once, then
 * the runtime's answer as the toast and the list again. */
function RemoveProjectControl({ project, refusal, line, api, onRemoved, failed, done }: { project: ProjectView; refusal: string | null; line: string; api: Api | null; onRemoved: () => void; failed: (e: unknown) => void; done: (line: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = (): void => {
    if (api?.projectsRemove === undefined) return;
    setBusy(true);
    void api
      .projectsRemove(project.id)
      .then(
        ({ said }) => {
          setAsking(false);
          if (said !== undefined) done(said);
          onRemoved();
        },
        failed,
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Button data-k="remove-project" size="xs" variant="outline" className={DANGER_BUTTON} held={refusal !== null || api?.projectsRemove === undefined} onClick={() => setAsking(true)}>
        {PROJECTS_WORDS.remove}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup data-remove-project-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle data-k="remove-project-title">{PROJECTS_WORDS.removeAsk(project.name)}</AlertDialogTitle>
            <AlertDialogDescription data-k="remove-project-sentence">{line}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{WHERE_WORDS.cancel}</AlertDialogClose>
            <Button data-k="remove-project-confirm" variant="destructive" disabled={busy} onClick={remove}>
              {PROJECTS_WORDS.remove}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** A select that names what it inherits grows to say all of it, from the one width the rest take. */
const INHERITS_WIDTH = cn(SELECT_WIDTH, "w-auto min-w-44 max-sm:w-auto max-sm:min-w-36");

/** What each project's new threads start on as the host resolves it, read again whenever the record they are
 * resolved from moves. */
function useProjectDefaults(ctx: SettingsContext): Record<string, ThreadDefaults> | null {
  const read = ctx.api?.projectsDefaults;
  const [defaults, setDefaults] = useState<Record<string, ThreadDefaults> | null>(null);
  const { defaultAgent, agentDefaults, projectDefaults } = ctx.preferences;
  const moved = JSON.stringify([defaultAgent, agentDefaults, projectDefaults]);
  useEffect(() => {
    if (read === undefined) return;
    let live = true;
    read().then(
      next => live && setDefaults(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [read, moved]);
  return defaults;
}

/** New threads in this project: its own agent, model and access over each agent's, each row naming what it takes
 * while unset and carrying the arrow back while set, written through the host's preferences. */
function ProjectNewThreads({ project, ctx }: { project: ProjectView; ctx: SettingsContext }) {
  const resolved = useProjectDefaults(ctx)?.[project.id];
  const own = ctx.preferences.projectDefaults[project.id] ?? {};
  const set = (patch: ProjectOverridesPatch): void => ctx.setPreferences({ projectDefaults: { [project.id]: patch } });
  const globalAgent = defaultAgentOf(ctx.harnesses);
  const agentId = resolved?.agent.value ?? own.agent ?? globalAgent?.harness;
  const catalog = ctx.harnesses.find(c => c.harness === agentId);
  if (globalAgent === undefined || catalog === undefined) return null;
  const agentPicks = newThreadPicks(catalog);
  // A word no agent, model or access is spelled as: the select's empty value reads as a placeholder.
  const UNSET = "@unset";
  const unsetAgent = PROJECTS_WORDS.inherits(globalAgent.label);
  const unsetModel = agentPicks.model === undefined ? undefined : PROJECTS_WORDS.inherits(modelLabel(catalog, agentPicks.model));
  const unsetAccess = agentPicks.access === undefined ? undefined : PROJECTS_WORDS.inherits(AGENTS_PAGE_WORDS.accessWords[agentPicks.access], catalog.label);
  const models = [...catalog.models, ...(catalog.legacyModels ?? [])];
  const accesses = ACCESS_CHOICES.filter(word => accessRefusal(catalog, word) === null);
  const modelSet = own.model !== undefined && resolved?.model?.from === "project";
  return (
    <Card id="project-new-threads" head={PROJECTS_WORDS.newThreads}>
      <Row
        id="project-agent"
        title={PROJECTS_WORDS.defaultAgent}
        description={own.agent === undefined ? PROJECTS_WORDS.agentUnset : PROJECTS_WORDS.agentSet}
        control={
          <Select value={own.agent ?? UNSET} onValueChange={next => set({ agent: next === UNSET ? null : (next as string) })}>
            <SelectTrigger size="sm" aria-label={PROJECTS_WORDS.defaultAgent} data-k="project-agent" className={INHERITS_WIDTH}>
              <SelectValue>{(value: string) => (value === UNSET ? unsetAgent : <AgentChoice id={value} label={ctx.harnesses.find(c => c.harness === value)?.label ?? agentName(value)} />)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={UNSET}>{unsetAgent}</SelectItem>
              {ctx.harnesses.map(c => (
                <SelectItem key={c.harness} value={c.harness}>
                  <AgentChoice id={c.harness} label={c.label} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
        {...(own.agent === undefined ? {} : { reset: () => set({ agent: null }) })}
      />
      {unsetModel === undefined ? null : (
        <Row
          id="project-model"
          title={PROJECTS_WORDS.model}
          description={modelSet ? PROJECTS_WORDS.ownSet : PROJECTS_WORDS.ownUnset}
          control={
            <Select value={modelSet ? own.model! : UNSET} onValueChange={next => set({ model: next === UNSET ? null : (next as string) })}>
              <SelectTrigger size="sm" aria-label={PROJECTS_WORDS.model} data-k="project-model" className={INHERITS_WIDTH}>
                <SelectValue>{(value: string) => (value === UNSET ? unsetModel : modelLabel(catalog, value))}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={UNSET}>{unsetModel}</SelectItem>
                {models.map(m => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
          {...(modelSet ? { reset: () => set({ model: null }) } : {})}
        />
      )}
      {unsetAccess === undefined ? null : (
        <Row
          id="project-access"
          title={PROJECTS_WORDS.access}
          description={own.access === undefined ? PROJECTS_WORDS.ownUnset : PROJECTS_WORDS.ownSet}
          control={
            <Select value={own.access ?? UNSET} onValueChange={next => set({ access: next === UNSET ? null : (next as AccessChoice) })}>
              <SelectTrigger size="sm" aria-label={PROJECTS_WORDS.access} data-k="project-access" className={INHERITS_WIDTH}>
                <SelectValue>{(value: string) => (value === UNSET ? unsetAccess : AGENTS_PAGE_WORDS.accessWords[value as AccessChoice])}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={UNSET}>{unsetAccess}</SelectItem>
                {accesses.map(word => (
                  <SelectItem key={word} value={word}>
                    {AGENTS_PAGE_WORDS.accessWords[word]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
          {...(own.access === undefined ? {} : { reset: () => set({ access: null }) })}
        />
      )}
    </Card>
  );
}

/** One project's own page. */
/** The threads on a project's workspaces, off the sidebar's own snapshots so the page counts what the sidebar shows. */
function ThreadCount({ project }: { project: Pick<ProjectView, "id"> }) {
  const threads = useSidebarProjects()
    .filter(snapshot => snapshot.workspace.project.id === project.id)
    .flatMap(snapshot => snapshot.threads);
  const running = threads.filter(thread => thread.status === "running").length;
  return (
    <span data-k="project-threads" className={VALUE}>
      {PROJECTS_WORDS.threads(threads.length, running)}
    </span>
  );
}

/** The repository's page in the browser, where the remote is one a browser can open. */
function RemoteOpen({ remote }: { remote: string }) {
  const url = /^https?:\/\//.test(remote) ? remote : /^git@([^:]+):(.+?)(\.git)?$/.exec(remote)?.slice(1, 3).join("/");
  if (url === undefined) return null;
  const href = url.startsWith("http") ? url : `https://${url}`;
  return (
    <Button size="xs" variant="outline" data-k="remote-open" onClick={() => void window.open(href, "_blank", "noopener,noreferrer")}>
      {PROJECTS_WORDS.open}
    </Button>
  );
}

export function ProjectPage({ project, ctx }: { project: ProjectView; ctx: SettingsContext }) {
  const place = ctx.places.find(p => p.id === project.computer);
  const computer = project.computer === HERE_PLACE_ID ? hereName(ctx.places) : place === undefined ? project.computer : placeName(place);
  const standing = workspacesOn(ctx, project);
  const refusal = standing.length === 0 ? null : projectInUseRefusal(project.name, standing);
  const line = removeLine(ctx, project);
  const facts: SettingsItem[] = [
    { kind: "line", id: "branch", label: PROJECTS_WORDS.branch, value: project.base ?? project.defaultBranch, hover: PROJECTS_WORDS.branchDescription, attrs: { "data-k": "branch" } },
    { kind: "line", id: "added", label: PROJECTS_WORDS.added, value: builtWhen(project.createdAt, ctx.now), hover: PROJECTS_WORDS.addedHover, attrs: { "data-k": "added" } },
    ...(project.seeded === undefined
      ? []
      : [{ kind: "line" as const, id: "seeded", label: PROJECTS_WORDS.seeded, value: [plural(project.seeded.files, "file"), fmtBytes(project.seeded.bytes), `memory ${project.seeded.memory}`], hover: PROJECTS_WORDS.seededHover(hereName(ctx.places)), attrs: { "data-k": "seeded" } }]),
  ];
  const look = ctx.preferences.projectLook[project.id];
  const icon = look?.icon ?? "folder";
  const hue = look?.hue ?? "neutral";
  const setLook = (next: ProjectLook): void => ctx.setPreferences({ projectLook: { [project.id]: next } });
  const cards: SettingsCardData[] = [
    {
      id: "project",
      items: [],
      body: (
        <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>
          <HeadRow glyph={<ProjectGlyph projectId={project.id} />} title={project.name} line={<span className="font-mono">{PROJECTS_WORDS.where(sourceWord(project.source), computer)}</span>} slot={<ThreadCount project={project} />} attrs={{ "data-k": "project-head" }} />
          {project.remote === undefined || project.remote === "" ? null : <Row id="remote" title={PROJECTS_WORDS.repository} description={project.remote} mono control={<RemoteOpen remote={project.remote} />} attrs={{ "data-k": "remote" }} />}
        </div>
      ),
    },
    { id: "facts", head: PROJECTS_WORDS.about, items: facts },
    {
      id: "look",
      head: PROJECTS_WORDS.look,
      items: [
        { kind: "row", id: "icon", title: PROJECTS_WORDS.icon, description: PROJECTS_WORDS.iconDescription, control: <IconSelect icon={icon} hue={hue} onChange={next => setLook({ icon: next, hue })} /> },
        { kind: "row", id: "hue", title: PROJECTS_WORDS.hue, description: PROJECTS_WORDS.hueDescription, control: <HueSelect hue={hue} onChange={next => setLook({ icon, hue: next })} /> },
      ],
    },
    {
      id: "acts",
      items: [
        {
          kind: "row",
          id: "remove",
          title: PROJECTS_WORDS.removeTitle(project.name),
          description: refusal ?? line,
          control: <RemoveProjectControl project={project} refusal={refusal} line={line} api={ctx.api} onRemoved={() => void setTimeout(() => ctx.go({ kind: "group", group: "projects" }), 0)} failed={ctx.failed} done={ctx.done} />,
        },
      ],
    },
  ];
  return (
    <>
      <Cards cards={cards.slice(0, 1)} />
      <ProjectNewThreads project={project} ctx={ctx} />
      <Cards cards={cards.slice(1)} />
    </>
  );
}
