// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer as one dialog, 680 px wide and one height across its steps:
// the header carries the step's name, a line only where the rows do not say
// it, the step's place in the run as a quiet mono figure and, once a choice is
// kept, that it is saved; the body is the step's rows in the settings list
// grammar; the foot is Back and Continue beside the key that closes it. The
// running view is the same rows in the same order, several running at once,
// a row that needs the person opening under itself with its acts. When every
// row is done, Next opens the ready page: the app's hero field behind the
// box's name and the one act.
import { CheckIcon, ExternalLinkIcon, GitCommitHorizontalIcon, GithubIcon, ListChecksIcon, PlugIcon, PuzzleIcon, ScrollTextIcon, ServerIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { fmtBytes, type ProjectHue, type ProjectIcon, type SizeTone } from "@wsp/protocol";
import { AgentMarks } from "../../components/agents/agentsParts.js";
import { HarnessMark } from "../../components/chat/HarnessMark.js";
import { HeroField } from "../../components/chat/EmptyHero.js";
import { AddButton } from "../../components/ui/add-button.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Radio, RadioGroup } from "../../components/ui/radio-group.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { cn } from "../../lib/utils.js";
import { PROJECT_GLYPHS, PROJECT_HUES } from "../../projects/look.js";
import { HueSelect, IconSelect } from "../../projects/LookPicker.js";
import { ComputerGlyph } from "../../settings/ComputerGlyph.js";
import { FACT } from "../../settings/format.js";
import { GlyphFrame, Grid, GridHead, GridName, GridRow } from "../../settings/grid.js";
import { CARD_INSET, LIST_TITLE, NOTE, ROW_FIELD, ROW_FLOOR, SELECT_WIDTH } from "../../settings/layout.js";
import { SizeCell } from "../../settings/recipe/rows.js";
import { Card, Line } from "../../settings/rows.js";
import { CopyRow, RefusalSlot } from "../../settings/sheetParts.js";
import { ADDED_FOLDER, AGENTS, BOX_NAME, CHECKS_REFUSED, CHECKS_RUNNING, CLIS, CONFIGS, GITHUB_CHOICES, HERE, HOST_KEY, MAC_NAME, NAME_TAKEN, NEEDS_GITHUB, PLUGINS, PROJECTS, RECIPES, RUNNING, RUNNING_BLOCKED, RUNNING_DONE, RUNNING_FAILED, SERVERS, SKILLS, SSH_HOSTS, STUDIO, SUMMARY, type ProjectPick, type StepLine } from "./fixtures.js";
import { PickLine, PickRow } from "./PickRow.js";
import { RetryActs, StepRow } from "./StepRow.js";
import { markSaved, useSaves } from "./saves.js";
import "./autosave.css";

export type Screen =
  | "where"
  | "hostkey"
  | "checks"
  | "checks-refused"
  | "startfrom"
  | "agents"
  | "mcp"
  | "clis"
  | "skills"
  | "plugins"
  | "github"
  | "projects"
  | "projects-add"
  | "projects-taken"
  | "projects-nogithub"
  | "other"
  | "summary"
  | "summary-disk"
  | "running"
  | "running-failed"
  | "running-blocked"
  | "running-done"
  | "ready";

/** The steps a person walks, in the order they run. Start from is skipped when no recipe is saved. */
const STEPS: readonly Screen[] = ["where", "checks", "startfrom", "agents", "mcp", "clis", "skills", "plugins", "github", "projects", "other", "summary"];

const STEP_OF: Partial<Record<Screen, Screen>> = { hostkey: "where", "checks-refused": "checks", "projects-add": "projects", "projects-taken": "projects", "projects-nogithub": "projects", "summary-disk": "summary" };
const stepOf = (screen: Screen): Screen => STEP_OF[screen] ?? screen;

/** The title and, only where the rows do not say it, one line under it. */
const HEAD: Record<Screen, { title: string; line?: string }> = {
  where: { title: "Add a computer", line: "A Linux box you have root on." },
  hostkey: { title: "Add a computer", line: "A Linux box you have root on." },
  checks: { title: "Checks" },
  "checks-refused": { title: "Checks" },
  startfrom: { title: "Start from" },
  agents: { title: "Agents" },
  mcp: { title: "MCP servers" },
  clis: { title: "CLIs" },
  skills: { title: "Skills" },
  plugins: { title: "Plugins" },
  github: { title: "GitHub" },
  projects: { title: "Import projects" },
  "projects-add": { title: "Import projects" },
  "projects-taken": { title: "Import projects" },
  "projects-nogithub": { title: "Import projects" },
  other: { title: "Other config" },
  summary: { title: "Summary" },
  "summary-disk": { title: "Summary" },
  running: { title: `Setting up ${BOX_NAME}`, line: "You can close this. Setup keeps going." },
  "running-failed": { title: `${BOX_NAME} needs you`, line: "Everything else is done." },
  "running-blocked": { title: `Setup on ${BOX_NAME} failed` },
  "running-done": { title: `${BOX_NAME} is ready`, line: "Set up in 6 min 12 s." },
  ready: { title: `${BOX_NAME} is ready` },
};

/** The size colours the coordinator ruled: neutral under 50 MB, yellow to 200 MB, orange to 1 GB, red over, in the
 * inks the app's size cells already wear. The protocol's own ladder is 100 MB, 300 MB, 1 GB. */
const MB = 1024 * 1024;
const sizeToneAt = (bytes: number): SizeTone => (bytes >= 1024 * MB ? "danger" : bytes >= 200 * MB ? "warning" : bytes >= 50 * MB ? "yellow" : "muted");
const Size = ({ bytes }: { bytes: number }) => (
  <SizeCell tone={sizeToneAt(bytes)} className="text-[13px]">
    {fmtBytes(bytes)}
  </SizeCell>
);

const ssh = (host: (typeof SSH_HOSTS)[number]): string => [host.user, host.hostName ?? host.alias].filter(Boolean).join("@");

function WhereStep({ hostKey }: { hostKey: boolean }) {
  return (
    <>
      <Input data-k="where-field" aria-label="Address" defaultValue="studio" placeholder="user@host or an ssh alias" className="font-mono" />
      {hostKey ? (
        <div className="flex flex-col gap-2">
          <p className={NOTE}>{BOX_NAME}'s host key is new to this Mac.</p>
          <CopyRow k="host-key" label={HOST_KEY.kind} value={HOST_KEY.fingerprint} />
        </div>
      ) : (
        <Grid id="ssh-hosts" head={<GridHead cells={[{ word: "From your ssh config" }]} />}>
          {SSH_HOSTS.map(host => (
            <GridRow key={host.alias} columns="grid-cols-[minmax(0,1fr)_auto]" tight open={() => {}} attrs={{ "data-ssh-host": host.alias }}>
              <GridName
                glyph={
                  <GlyphFrame>
                    <ServerIcon aria-hidden className="size-4 text-foreground/80" />
                  </GlyphFrame>
                }
                name={host.alias}
              />
              {host.added === true ? (
                <span className="flex items-center gap-2" title="Already on this wsp">
                  <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </span>
              ) : (
                <span className={FACT}>{ssh(host)}</span>
              )}
            </GridRow>
          ))}
        </Grid>
      )}
    </>
  );
}

function ChecksStep({ rows }: { rows: readonly StepLine[] }) {
  return (
    <Grid id="checks">
      {rows.map(row => (
        <StepRow key={row.id} row={row} {...(row.state === "failed" ? { acts: <Button size="xs" variant="outline">Try again</Button> } : {})} />
      ))}
    </Grid>
  );
}

/** A radio list in the card: the radio, the mark in its frame, the name over a note, a fact at the right. */
function Choice({ id, picked, glyph, name, note, fact }: { id: string; picked: boolean; glyph: ReactNode; name: string; note: string; fact?: string }) {
  return (
    <label data-choice={id} className={cn("flex cursor-pointer items-center gap-3 py-3", CARD_INSET, ROW_FLOOR)}>
      <Radio value={id} />
      <GlyphFrame>{glyph}</GlyphFrame>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(LIST_TITLE, "min-w-0 break-words", !picked && "text-muted-foreground")}>{name}</span>
        <span className={NOTE}>{note}</span>
      </span>
      {fact === undefined ? null : <span className={cn(FACT, "shrink-0")}>{fact}</span>}
    </label>
  );
}

function StartFromStep() {
  const [picked, setPicked] = useState("mac");
  return (
    <RadioGroup
      value={picked}
      onValueChange={next => {
        setPicked(String(next));
        markSaved();
      }}
      className="gap-0"
    >
      <Grid id="start-from">
        <Choice id="mac" picked={picked === "mac"} glyph={<ComputerGlyph place={HERE} className="size-4 text-foreground/80" />} name={`Everything on ${MAC_NAME}`} note="3 agents, 14 MCP servers, 9 CLIs, 78 skills, 17 plugins, every project." />
        {RECIPES.map(recipe => {
          const Glyph = PROJECT_GLYPHS[recipe.icon];
          return <Choice key={recipe.id} id={recipe.id} picked={picked === recipe.id} glyph={<Glyph aria-hidden className="size-4 text-foreground/80" />} name={recipe.name} note={recipe.holds} {...(recipe.machines.length === 0 ? {} : { fact: `on ${recipe.machines.join(", ")}` })} />;
        })}
        <Choice id="none" picked={picked === "none"} glyph={<ListChecksIcon aria-hidden className="size-4 text-foreground/80" />} name="Pick each step" note="Nothing ticked." />
      </Grid>
    </RadioGroup>
  );
}

function GitHubStep() {
  const [picked, setPicked] = useState("token");
  return (
    <RadioGroup
      value={picked}
      onValueChange={next => {
        setPicked(String(next));
        markSaved();
      }}
      className="gap-0"
    >
      <Grid id="github">
        {GITHUB_CHOICES.map(choice => (
          <Choice key={choice.id} id={choice.id} picked={picked === choice.id} glyph={<GithubIcon aria-hidden className="size-4 text-foreground/80" />} name={choice.name} note={choice.note} />
        ))}
      </Grid>
    </RadioGroup>
  );
}

function WordSelect({ value, words, label }: { value: string; words: readonly string[]; label: string }) {
  const [picked, setPicked] = useState(value);
  return (
    <Select
      value={picked}
      onValueChange={next => {
        setPicked(String(next));
        markSaved();
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className={SELECT_WIDTH}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {words.map(word => (
          <SelectItem key={word} value={word}>
            {word}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The ticks of a list, by id. */
function useTicks<T extends { id: string; ticked: boolean }>(rows: readonly T[]): [Record<string, boolean>, (id: string, next: boolean) => void] {
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(rows.map(row => [row.id, row.ticked])));
  return [
    ticks,
    (id, next) => {
      setTicks(t => ({ ...t, [id]: next }));
      markSaved();
    },
  ];
}

function AgentsStep() {
  const [ticks, tick] = useTicks(AGENTS);
  return (
    <Grid id="agents">
      {AGENTS.map(agent => (
        <PickRow
          key={agent.id}
          id={agent.id}
          checked={ticks[agent.id] === true}
          onCheckedChange={next => tick(agent.id, next)}
          glyph={<HarnessMark harness={agent.id} label={agent.name} className="size-5" />}
          name={agent.name}
          tag={agent.version}
          note={agent.note}
          {...(ticks[agent.id] === true ? { slot: <WordSelect value={agent.signIn} words={agent.signIns} label={`${agent.name} sign-in`} /> } : {})}
        />
      ))}
    </Grid>
  );
}

function ServersStep() {
  const [ticks, tick] = useTicks(SERVERS);
  return (
    <Grid id="servers">
      {SERVERS.map(server => (
        <PickRow key={server.id} id={server.id} checked={ticks[server.id] === true} onCheckedChange={next => tick(server.id, next)} glyph={<PlugIcon aria-hidden className="size-4 text-foreground/80" />} name={server.name} marks={<AgentMarks agents={server.agents} />} note={server.note} />
      ))}
    </Grid>
  );
}

function ClisStep() {
  const [ticks, tick] = useTicks(CLIS);
  return (
    <Grid id="clis">
      {CLIS.map(cli => (
        <PickRow key={cli.id} id={cli.id} checked={ticks[cli.id] === true} onCheckedChange={next => tick(cli.id, next)} glyph={<TerminalIcon aria-hidden className="size-4 text-foreground/80" />} name={cli.name} tag={cli.version} note={cli.needs === undefined ? cli.via : `${cli.via}. ${cli.needs}`} slot={<Size bytes={cli.bytes} />} />
      ))}
    </Grid>
  );
}

function SkillsStep() {
  const [ticks, tick] = useTicks(SKILLS);
  return (
    <Grid id="skills">
      {SKILLS.map(item => (
        <PickRow key={item.id} id={item.id} checked={ticks[item.id] === true} onCheckedChange={next => tick(item.id, next)} glyph={<ScrollTextIcon aria-hidden className="size-4 text-foreground/80" />} name={item.name} marks={<AgentMarks agents={item.agents} />} slot={<span className={FACT}>{item.from}</span>} />
      ))}
    </Grid>
  );
}

function PluginsStep() {
  const [ticks, tick] = useTicks(PLUGINS);
  return (
    <Grid id="plugins">
      {PLUGINS.map(plugin => (
        <PickRow key={plugin.id} id={plugin.id} checked={ticks[plugin.id] === true} onCheckedChange={next => tick(plugin.id, next)} glyph={<PuzzleIcon aria-hidden className="size-4 text-foreground/80" />} name={plugin.name} tag={plugin.marketplace} {...(plugin.asks === undefined ? {} : { note: plugin.asks })} />
      ))}
    </Grid>
  );
}

function ProjectRow({ project, checked, onCheckedChange, taken, noGitHub }: { project: ProjectPick; checked: boolean; onCheckedChange: (next: boolean) => void; taken: boolean; noGitHub: boolean }) {
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState<ProjectIcon>(project.icon);
  const [hue, setHue] = useState<ProjectHue>(project.hue);
  const Glyph = PROJECT_GLYPHS[icon];
  const note = noGitHub && project.privateRepo === true ? NEEDS_GITHUB : project.note;
  return (
    <PickRow id={project.id} checked={checked} onCheckedChange={onCheckedChange} glyph={<Glyph aria-hidden className={cn("size-4", hue === "neutral" ? "text-foreground/80" : PROJECT_HUES[hue].text)} />} name={name} tag={project.path} note={note} slot={<Size bytes={project.bytes} />}>
      {checked ? (
        <>
          <PickLine label="Name">
            <span className="flex flex-col items-end gap-1">
              <Input data-k="project-name" aria-label="Project name" aria-invalid={taken || undefined} value={name} onChange={e => setName(e.target.value)} className={cn(ROW_FIELD, "w-44 max-sm:w-36")} autoFocus={project.added === true || taken} />
              {taken ? (
                <span data-k="name-taken" className="text-[13px] leading-[18px] text-destructive-foreground">
                  {NAME_TAKEN(BOX_NAME, project.name)}
                </span>
              ) : null}
            </span>
          </PickLine>
          <PickLine label="Icon">
            <IconSelect icon={icon} hue={hue} onChange={setIcon} />
          </PickLine>
          <PickLine label="Colour">
            <HueSelect hue={hue} onChange={setHue} />
          </PickLine>
        </>
      ) : null}
    </PickRow>
  );
}

function ProjectsStep({ added = false, taken = false, noGitHub = false }: { added?: boolean; taken?: boolean; noGitHub?: boolean }) {
  const rows = added ? [ADDED_FOLDER, ...PROJECTS] : PROJECTS;
  const [ticks, tick] = useTicks(rows);
  return (
    <>
      <Grid id="projects">
        {rows.map(project => (
          <ProjectRow key={project.id} project={project} checked={ticks[project.id] === true} onCheckedChange={next => tick(project.id, next)} taken={taken && project.id === "pr_wsp"} noGitHub={noGitHub} />
        ))}
      </Grid>
      <div className="flex">
        <AddButton data-k="add-folder">Add a folder…</AddButton>
      </div>
    </>
  );
}

const CONFIG_GLYPHS = { git: GitCommitHorizontalIcon, shell: SquareTerminalIcon } as const;

function OtherStep() {
  const [ticks, tick] = useTicks(CONFIGS);
  return (
    <Grid id="configs">
      {CONFIGS.map(config => {
        const Glyph = CONFIG_GLYPHS[config.id as keyof typeof CONFIG_GLYPHS];
        return <PickRow key={config.id} id={config.id} checked={ticks[config.id] === true} onCheckedChange={next => tick(config.id, next)} glyph={<Glyph aria-hidden className="size-4 text-foreground/80" />} name={config.name} note={config.note} />;
      })}
    </Grid>
  );
}

function SummaryStep({ refused }: { refused: boolean }) {
  const disk = refused ? SUMMARY.diskRefused : SUMMARY.disk;
  const [save, setSave] = useState(true);
  const [icon, setIcon] = useState<ProjectIcon>("rocket");
  const Glyph = PROJECT_GLYPHS[icon];
  return (
    <>
      <Card id="summary-lines">
        {SUMMARY.lines.map(([label, value]) => (
          <Line key={label} id={label} label={label} value={value} valueClass="fact" />
        ))}
        <Line
          id="disk"
          label={`Disk on ${BOX_NAME}`}
          hover={disk.note}
          control={
            <span data-k="disk" className={cn("text-[13px] tabular-nums sm:text-right", disk.tone === "danger" ? "text-destructive-foreground" : "text-muted-foreground")}>
              {disk.need} needed, {disk.free} free
            </span>
          }
        />
      </Card>
      {refused ? <RefusalSlot k="disk-refused" said={`${BOX_NAME} has ${disk.free} free; these picks need ${disk.need}.`} fix="Untick cargo-nextest to leave build-essential out, or free room on studio." /> : null}
      <Card id="save-recipe">
        <PickRow id="save" checked={save} onCheckedChange={setSave} glyph={<Glyph aria-hidden className="size-4 text-foreground/80" />} name="Save as a recipe" note="The next box starts from these picks.">
          {save ? (
            <>
              <PickLine label="Name">
                <Input data-k="recipe-name" aria-label="Recipe name" defaultValue="Builders" className={cn(ROW_FIELD, "w-44 max-sm:w-36")} />
              </PickLine>
              <PickLine label="Icon">
                <IconSelect icon={icon} hue="neutral" onChange={setIcon} />
              </PickLine>
            </>
          ) : null}
        </PickRow>
      </Card>
    </>
  );
}

function WaitBlock({ wait }: { wait: NonNullable<StepLine["wait"]> }) {
  return (
    <>
      <div data-sign-in-line className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
        <span data-k="sign-in-code" className="font-mono text-xl tabular-nums text-foreground">
          {wait.code}
        </span>
        <Button size="xs" variant="outline" onClick={() => void window.open(wait.url, "_blank", "noopener,noreferrer")}>
          <ExternalLinkIcon aria-hidden className="size-3.5" />
          Open the tab again
        </Button>
        <Button size="xs" variant="ghost">
          Skip for now
        </Button>
      </div>
      <p className={NOTE}>You can sign in later in Settings.</p>
    </>
  );
}

function RunningView({ rows, blocked }: { rows: readonly StepLine[]; blocked: boolean }) {
  // The list opens on the first row that waits on the person, so a long run never hides the one act it asks for.
  useEffect(() => {
    document.querySelector("[data-add-computer] [data-step-row][data-state='needs-you'], [data-add-computer] [data-step-row][data-state='failed']")?.scrollIntoView({ block: "center" });
  }, [rows]);
  return (
    <Grid id="setup">
      {rows.map(row => (
        <StepRow key={row.id} row={row} {...(row.state === "failed" ? { acts: <RetryActs skip={!blocked} /> } : {})}>
          {row.wait === undefined ? undefined : <WaitBlock wait={row.wait} />}
        </StepRow>
      ))}
    </Grid>
  );
}

/** The page after every row is done: the hero field the app draws behind a fresh thread, a soft glow in the same ink,
 * the box's glyph and name, and the one act. */
function ReadyPage() {
  return (
    <div data-k="ready-page" className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-xl px-6 py-12 text-center">
      <HeroField />
      <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -z-10 size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--hero-field)_22%,transparent),transparent)]" />
      <span className="flex size-12 items-center justify-center rounded-lg border border-border bg-foreground/[0.04]">
        <ComputerGlyph place={STUDIO} className="size-6 text-foreground/80" />
      </span>
      <h2 data-k="ready-title" className="mt-5 text-2xl/8 font-medium tracking-[-0.01em] text-foreground">
        {BOX_NAME} is ready
      </h2>
      <p className={cn(NOTE, "mt-1.5")}>Claude Code and Codex, 7 MCP servers, 78 skills, 2 projects.</p>
      <div className="mt-7 flex items-center gap-2">
        <Button data-k="start-task">Start a task here</Button>
        <Button variant="ghost" data-k="ready-close">
          Close
        </Button>
      </div>
    </div>
  );
}

const RUNS: Partial<Record<Screen, readonly StepLine[]>> = { running: RUNNING, "running-failed": RUNNING_FAILED, "running-blocked": RUNNING_BLOCKED, "running-done": RUNNING_DONE };

function body(screen: Screen): ReactNode {
  switch (screen) {
    case "where":
      return <WhereStep hostKey={false} />;
    case "hostkey":
      return <WhereStep hostKey />;
    case "checks":
      return <ChecksStep rows={CHECKS_RUNNING} />;
    case "checks-refused":
      return <ChecksStep rows={CHECKS_REFUSED} />;
    case "startfrom":
      return <StartFromStep />;
    case "agents":
      return <AgentsStep />;
    case "mcp":
      return <ServersStep />;
    case "clis":
      return <ClisStep />;
    case "skills":
      return <SkillsStep />;
    case "plugins":
      return <PluginsStep />;
    case "github":
      return <GitHubStep />;
    case "projects":
      return <ProjectsStep />;
    case "projects-add":
      return <ProjectsStep added />;
    case "projects-taken":
      return <ProjectsStep taken />;
    case "projects-nogithub":
      return <ProjectsStep noGitHub />;
    case "other":
      return <OtherStep />;
    case "summary":
      return <SummaryStep refused={false} />;
    case "summary-disk":
      return <SummaryStep refused />;
    default:
      return <RunningView rows={RUNS[screen] ?? RUNNING} blocked={screen === "running-blocked"} />;
  }
}

/** The figure in the header: the step's place while choosing, the steps done of all while running. */
function progress(screen: Screen, rows: readonly StepLine[] | undefined): { words: string; why: string } {
  if (rows !== undefined) {
    const steps = rows.filter(row => row.sub !== true);
    const done = steps.filter(row => row.state === "done").length;
    return { words: `${done} of ${steps.length} done`, why: `${done} of ${steps.length} steps done` };
  }
  const at = STEPS.indexOf(stepOf(screen)) + 1;
  return { words: `${at} of ${STEPS.length}`, why: `Step ${at} of ${STEPS.length}` };
}

/** From the first choice on, the choices are kept as a pending machine; the foot says so, quietly. */
const saved = (screen: Screen): boolean => STEPS.indexOf(stepOf(screen)) >= STEPS.indexOf("startfrom") && RUNS[screen] === undefined && screen !== "ready";

/** The foot's left: the auto-save check, drawn in again on every save, and the one line. The check is keyed on the
 * save count so a landed save remounts it and its stroke draws in once more. */
function SavedLine() {
  const n = useSaves(s => s.n);
  return (
    <span data-k="saved" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <CheckIcon key={n} aria-hidden className="proto-autosave size-3.5 shrink-0" />
      Saved, you can finish later
    </span>
  );
}

/** The dialog's foot without the Esc keycap: the saved line at the left once a choice is kept, the acts at the right.
 * Under 640 px the acts stack with the primary on top and the line stands under them. */
function Foot({ left, children }: { left: ReactNode; children: ReactNode }) {
  return (
    <div data-slot="dialog-footer" className="flex flex-col-reverse gap-2 px-5 pt-3 pb-4 sm:flex-row sm:items-center sm:justify-end">
      <span className="flex min-h-5 items-center max-sm:justify-center sm:me-auto">{left}</span>
      {children}
    </div>
  );
}

function foot(screen: Screen): ReactNode {
  const back = (
    <Button variant="outline" data-k="back">
      Back
    </Button>
  );
  const next = (word = "Continue", held = false) => (
    <Button data-k="continue" held={held}>
      {word}
    </Button>
  );
  const close = (
    <Button variant="outline" data-k="close">
      Close
    </Button>
  );
  switch (screen) {
    case "where":
      return (
        <>
          <Button variant="outline">Cancel</Button>
          {next("Connect")}
        </>
      );
    case "hostkey":
      return (
        <>
          <Button variant="outline">Cancel</Button>
          {next("Trust and connect")}
        </>
      );
    case "checks":
    case "checks-refused":
      return (
        <>
          {back}
          {next("Continue", true)}
        </>
      );
    case "projects-taken":
      return (
        <>
          {back}
          {next("Continue", true)}
        </>
      );
    case "summary":
      return (
        <>
          {back}
          {next(`Set up ${BOX_NAME}`)}
        </>
      );
    case "summary-disk":
      return (
        <>
          {back}
          {next(`Set up ${BOX_NAME}`, true)}
        </>
      );
    case "running":
    case "running-failed":
    case "running-blocked":
      return close;
    case "running-done":
      return (
        <>
          {close}
          {next("Next")}
        </>
      );
    default:
      return (
        <>
          {back}
          {next()}
        </>
      );
  }
}

export function AddComputerDialog({ screen }: { screen: Screen }) {
  const head = HEAD[screen];
  const at = progress(screen, RUNS[screen]);
  const popup = "max-w-[560px] [--settings-inset:16px] sm:h-[640px]";
  if (screen === "ready") {
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogPopup data-add-computer={screen} initialFocus={false} className={popup}>
          <DialogTitle className="sr-only">{head.title}</DialogTitle>
          <ReadyPage />
        </DialogPopup>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogPopup data-add-computer={screen} initialFocus={screen === "where" || screen === "hostkey" ? undefined : false} className={popup}>
        <div className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="flex-row items-start justify-between gap-6 pb-3">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle>{head.title}</DialogTitle>
              {head.line === undefined ? null : <DialogDescription>{head.line}</DialogDescription>}
            </div>
            <span data-k="progress" className={cn(FACT, "shrink-0 pt-0.5")} title={at.why}>
              {at.words}
            </span>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5 pt-2 pb-5">{body(screen)}</DialogPanel>
          <Foot left={saved(screen) ? <SavedLine /> : null}>{foot(screen)}</Foot>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
