// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer as one dialog, 560 px wide and one height across its steps:
// the header carries the step's name, one line, and the step's place in the
// run as a quiet mono figure; the body is the step's rows in the settings list
// grammar; the foot is Back and Continue beside the key that closes it. There
// is no step rail: the steps are read one at a time, in the order they will
// run. The running view is the same rows in the same order, each with its
// state mark, a step that needs the person opening under itself with its acts.
import { CheckIcon, ExternalLinkIcon, GitCommitHorizontalIcon, KeyRoundIcon, ListChecksIcon, PlugIcon, PuzzleIcon, ScrollTextIcon, ServerIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ProjectHue, ProjectIcon } from "@wsp/protocol";
import { AgentMarks } from "../../components/agents/agentsParts.js";
import { HarnessMark } from "../../components/chat/HarnessMark.js";
import { AddButton } from "../../components/ui/add-button.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../../components/ui/dialog.js";
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
import { Card, Line } from "../../settings/rows.js";
import { CopyRow, RefusalSlot } from "../../settings/sheetParts.js";
import { ADDED_FOLDER, AGENTS, BOX_NAME, CHECKS_REFUSED, CHECKS_RUNNING, CLIS, CONFIGS, HERE, HOST_KEY, MAC_NAME, PLUGINS, PLUGIN_COUNT, PROJECTS, RECIPES, RUNNING, RUNNING_BLOCKED, RUNNING_DONE, RUNNING_FAILED, SERVERS, SKILLS, SKILL_COUNT, SSH_HOSTS, SUMMARY, type ProjectPick, type StepLine } from "./fixtures.js";
import { PickLine, PickRow } from "./PickRow.js";
import { RetryActs, StepRow } from "./StepRow.js";

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
  | "projects"
  | "projects-add"
  | "other"
  | "summary"
  | "summary-disk"
  | "running"
  | "running-failed"
  | "running-blocked"
  | "running-done";

/** The steps a person walks, in the order they run, so the figure in the header is the same count the running
 * list shows. Start from is skipped when no recipe is saved. */
const STEPS: readonly { id: Screen; title: string }[] = [
  { id: "where", title: "Add a computer" },
  { id: "checks", title: "Checks" },
  { id: "startfrom", title: "Start from" },
  { id: "agents", title: "Agents" },
  { id: "mcp", title: "MCP servers" },
  { id: "clis", title: "CLIs" },
  { id: "skills", title: "Skills" },
  { id: "plugins", title: "Plugins" },
  { id: "projects", title: "Import projects" },
  { id: "other", title: "Other config" },
  { id: "summary", title: "Summary" },
];

const stepOf = (screen: Screen): Screen => (screen === "hostkey" ? "where" : screen === "checks-refused" ? "checks" : screen === "projects-add" ? "projects" : screen === "summary-disk" ? "summary" : screen);

/** The title and the one line under it, per screen; the running view's title is the machine's state. */
const HEAD: Record<Screen, { title: string; line: string }> = {
  where: { title: "Add a computer", line: "A Linux box you have root on. wsp installs itself over ssh and the box dials back here." },
  hostkey: { title: "Add a computer", line: "A Linux box you have root on. wsp installs itself over ssh and the box dials back here." },
  checks: { title: "Checks", line: `What ${BOX_NAME} is, before anything lands. Choosing starts once wsp dials back.` },
  "checks-refused": { title: "Checks", line: "What jumpbox is, before anything lands. Two things need fixing first." },
  startfrom: { title: "Start from", line: `Which ticks the next steps open with. Change any of them along the way.` },
  agents: { title: "Agents", line: `Which agents go on ${BOX_NAME}, and how each signs in there.` },
  mcp: { title: "MCP servers", line: "Each goes to the agents it is set up for here. Servers that only run on a Mac are not offered." },
  clis: { title: "CLIs", line: `From this Mac, at the versions here. One needs a compiler, said on its row.` },
  skills: { title: "Skills", line: `${SKILL_COUNT} skills from this Mac, each landing in the agents it is set up for.` },
  plugins: { title: "Plugins", line: `${PLUGIN_COUNT} Claude Code plugins installed here. One asks to run a command, so it waits for you.` },
  projects: { title: "Import projects", line: `Your wsp projects on ${MAC_NAME}. Any folder can become one.` },
  "projects-add": { title: "Import projects", line: `Your wsp projects on ${MAC_NAME}. Any folder can become one.` },
  other: { title: "Other config", line: `What makes ${BOX_NAME} feel like your machine. Nothing with a secret in it travels.` },
  summary: { title: "Summary", line: `What goes on ${BOX_NAME}. Save the picks as a recipe to reuse them on the next box.` },
  "summary-disk": { title: "Summary", line: `What goes on ${BOX_NAME}. Save the picks as a recipe to reuse them on the next box.` },
  running: { title: `Setting up ${BOX_NAME}`, line: "Codex needs you to sign in. Everything else carries on." },
  "running-failed": { title: `${BOX_NAME} needs you`, line: "Everything else is done. One project and one skill did not land." },
  "running-blocked": { title: `Setup on ${BOX_NAME} failed`, line: "Base packages did not install, so nothing after them ran." },
  "running-done": { title: `${BOX_NAME} is ready`, line: "Set up in 6 min 12 s. It follows the Builders recipe from here." },
};

const ssh = (host: (typeof SSH_HOSTS)[number]): string => [host.user, host.hostName ?? host.alias].filter(Boolean).join("@");

function WhereStep({ hostKey }: { hostKey: boolean }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Input data-k="where-field" aria-label="Address" defaultValue="studio" placeholder="user@host or an ssh alias" className="font-mono" />
        <p className={NOTE}>Root there; wsp never asks for a password.</p>
      </div>
      {hostKey ? (
        <div className="flex flex-col gap-2">
          <p className={NOTE}>{BOX_NAME}'s host key is new to this Mac. Check it against the box before trusting it.</p>
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

function StartFromStep() {
  const [picked, setPicked] = useState("mac");
  const choice = (id: string, glyph: ReactNode, name: string, note: string, fact?: string) => (
    <label key={id} data-start-from={id} className={cn("flex cursor-pointer items-center gap-3 py-3", CARD_INSET, ROW_FLOOR)}>
      <Radio value={id} />
      <GlyphFrame>{glyph}</GlyphFrame>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(LIST_TITLE, "min-w-0 break-words", picked !== id && "text-muted-foreground")}>{name}</span>
        <span className={NOTE}>{note}</span>
      </span>
      {fact === undefined ? null : <span className={cn(FACT, "shrink-0")}>{fact}</span>}
    </label>
  );
  return (
    <>
      <RadioGroup value={picked} onValueChange={next => setPicked(String(next))} className="gap-0">
        <Grid id="start-from">
          {choice("mac", <ComputerGlyph place={HERE} className="size-4 text-foreground/80" />, `Everything on ${MAC_NAME}`, "3 agents, 14 MCP servers, 9 CLIs, 78 skills, 17 plugins, every project.")}
          {RECIPES.map(recipe => {
            const Glyph = PROJECT_GLYPHS[recipe.icon];
            return choice(recipe.id, <Glyph aria-hidden className="size-4 text-foreground/80" />, recipe.name, recipe.holds, recipe.machines.length === 0 ? undefined : `on ${recipe.machines.join(", ")}`);
          })}
          {choice("none", <ListChecksIcon aria-hidden className="size-4 text-foreground/80" />, "Pick each step", "Start with nothing ticked.")}
        </Grid>
      </RadioGroup>
      <p className={NOTE}>Ticks you change in the next steps stay with {BOX_NAME}. A recipe changes only when you save it at the end.</p>
    </>
  );
}

function WordSelect({ value, words, label }: { value: string; words: readonly string[]; label: string }) {
  const [picked, setPicked] = useState(value);
  return (
    <Select value={picked} onValueChange={next => setPicked(String(next))}>
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

function AgentsStep() {
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(AGENTS.map(a => [a.id, a.ticked])));
  return (
    <>
      <Grid id="agents">
        {AGENTS.map(agent => (
          <PickRow
            key={agent.id}
            id={agent.id}
            checked={ticks[agent.id] === true}
            onCheckedChange={next => setTicks(t => ({ ...t, [agent.id]: next }))}
            glyph={<HarnessMark harness={agent.id} label={agent.name} className="size-5" />}
            name={agent.name}
            tag={agent.version}
            note={agent.note}
            {...(ticks[agent.id] === true ? { slot: <WordSelect value={agent.signIn} words={agent.signIns} label={`${agent.name} sign-in`} /> } : {})}
          />
        ))}
      </Grid>
      <p className={NOTE}>Installed first, then signed in. Versions follow {MAC_NAME}.</p>
    </>
  );
}

function ServersStep() {
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(SERVERS.map(s => [s.id, s.ticked])));
  return (
    <Grid id="servers">
      {SERVERS.map(server => (
        <PickRow
          key={server.id}
          id={server.id}
          checked={ticks[server.id] === true}
          onCheckedChange={next => setTicks(t => ({ ...t, [server.id]: next }))}
          glyph={<PlugIcon aria-hidden className="size-4 text-foreground/80" />}
          name={server.name}
          marks={<AgentMarks agents={server.agents} />}
          note={server.note}
        />
      ))}
    </Grid>
  );
}

function ClisStep() {
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(CLIS.map(c => [c.id, c.ticked])));
  return (
    <Grid id="clis">
      {CLIS.map(cli => (
        <PickRow
          key={cli.id}
          id={cli.id}
          checked={ticks[cli.id] === true}
          onCheckedChange={next => setTicks(t => ({ ...t, [cli.id]: next }))}
          glyph={<TerminalIcon aria-hidden className="size-4 text-foreground/80" />}
          name={cli.name}
          tag={cli.version}
          note={cli.needs === undefined ? `By ${cli.via}.` : `By ${cli.via}. ${cli.needs}`}
          slot={<span className={FACT}>{cli.size}</span>}
        />
      ))}
    </Grid>
  );
}

function SkillsStep() {
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(SKILLS.map(s => [s.id, s.ticked])));
  return (
    <Grid id="skills">
      {SKILLS.map(item => (
        <PickRow
          key={item.id}
          id={item.id}
          checked={ticks[item.id] === true}
          onCheckedChange={next => setTicks(t => ({ ...t, [item.id]: next }))}
          glyph={<ScrollTextIcon aria-hidden className="size-4 text-foreground/80" />}
          name={item.name}
          marks={<AgentMarks agents={item.agents} />}
          slot={<span className={FACT}>{item.from}</span>}
        />
      ))}
    </Grid>
  );
}

function PluginsStep() {
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(PLUGINS.map(p => [p.id, p.ticked])));
  return (
    <Grid id="plugins">
      {PLUGINS.map(plugin => (
        <PickRow
          key={plugin.id}
          id={plugin.id}
          checked={ticks[plugin.id] === true}
          onCheckedChange={next => setTicks(t => ({ ...t, [plugin.id]: next }))}
          glyph={<PuzzleIcon aria-hidden className="size-4 text-foreground/80" />}
          name={plugin.name}
          tag={plugin.marketplace}
          {...(plugin.asks === undefined ? {} : { note: plugin.asks })}
        />
      ))}
    </Grid>
  );
}

function ProjectRow({ project, checked, onCheckedChange }: { project: ProjectPick; checked: boolean; onCheckedChange: (next: boolean) => void }) {
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState<ProjectIcon>(project.icon);
  const [hue, setHue] = useState<ProjectHue>(project.hue);
  const Glyph = PROJECT_GLYPHS[icon];
  return (
    <PickRow id={project.id} checked={checked} onCheckedChange={onCheckedChange} glyph={<Glyph aria-hidden className={cn("size-4", hue === "neutral" ? "text-foreground/80" : PROJECT_HUES[hue].text)} />} name={name} tag={project.path} note={project.note} slot={<span className={FACT}>{project.size}</span>}>
      {checked ? (
        <>
          <PickLine label="Name">
            <Input data-k="project-name" aria-label="Project name" value={name} onChange={e => setName(e.target.value)} className={cn(ROW_FIELD, "w-44 max-sm:w-36")} autoFocus={project.added === true} />
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

function ProjectsStep({ added }: { added: boolean }) {
  const rows = added ? [ADDED_FOLDER, ...PROJECTS] : PROJECTS;
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(rows.map(p => [p.id, p.ticked])));
  return (
    <>
      <Grid id="projects">
        {rows.map(project => (
          <ProjectRow key={project.id} project={project} checked={ticks[project.id] === true} onCheckedChange={next => setTicks(t => ({ ...t, [project.id]: next }))} />
        ))}
      </Grid>
      <div className="flex">
        <AddButton data-k="add-folder">Add a folder…</AddButton>
      </div>
    </>
  );
}

const CONFIG_GLYPHS = { git: GitCommitHorizontalIcon, shell: SquareTerminalIcon, github: KeyRoundIcon } as const;

function OtherStep() {
  const [ticks, setTicks] = useState<Record<string, boolean>>(Object.fromEntries(CONFIGS.map(c => [c.id, c.ticked])));
  return (
    <Grid id="configs">
      {CONFIGS.map(config => {
        const Glyph = CONFIG_GLYPHS[config.id as keyof typeof CONFIG_GLYPHS];
        return (
          <PickRow
            key={config.id}
            id={config.id}
            checked={ticks[config.id] === true}
            onCheckedChange={next => setTicks(t => ({ ...t, [config.id]: next }))}
            glyph={<Glyph aria-hidden className="size-4 text-foreground/80" />}
            name={config.name}
            note={config.note}
            {...(config.signIns !== undefined && config.signIn !== undefined && ticks[config.id] === true ? { slot: <WordSelect value={config.signIn} words={config.signIns} label={`${config.name} sign-in`} /> } : {})}
          />
        );
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
        <PickRow id="save" checked={save} onCheckedChange={setSave} glyph={<Glyph aria-hidden className="size-4 text-foreground/80" />} name="Save as a recipe" note="The next box starts from these picks, and follows them as they change here.">
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
          Later
        </Button>
      </div>
      <p className={NOTE}>
        {wait.left}. Later leaves this on {BOX_NAME}'s page; everything else finishes.
      </p>
    </>
  );
}

function RunningView({ rows, blocked }: { rows: readonly StepLine[]; blocked: boolean }) {
  // The list opens on the first row that waits on the person, so a long run never hides the one act it asks for.
  useEffect(() => {
    document.querySelector("[data-add-computer] [data-step-row][data-state='needs-you'], [data-add-computer] [data-step-row][data-state='failed']")?.scrollIntoView({ block: "center" });
  }, [rows]);
  return (
    <>
      <Grid id="setup">
        {rows.map(row => (
          <StepRow key={row.id} row={row} {...(row.state === "failed" ? { acts: <RetryActs skip={!blocked} /> } : {})}>
            {row.wait === undefined ? undefined : <WaitBlock wait={row.wait} />}
          </StepRow>
        ))}
      </Grid>
      {rows.some(row => row.state === "working") ? <p className={NOTE}>You can close this. Setup carries on in the background, and wsp pings you when it needs you.</p> : null}
    </>
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
    case "projects":
      return <ProjectsStep added={false} />;
    case "projects-add":
      return <ProjectsStep added />;
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

/** The figure in the header: the step's place while choosing, the steps done while running. */
function progress(screen: Screen, rows: readonly StepLine[] | undefined): { words: string; why: string } {
  if (rows !== undefined) {
    const steps = rows.filter(row => row.sub !== true);
    const done = steps.filter(row => row.state === "done").length;
    return { words: `${done} of ${steps.length}`, why: `${done} of ${steps.length} steps done` };
  }
  const at = STEPS.findIndex(step => step.id === stepOf(screen)) + 1;
  return { words: `${at} of ${STEPS.length}`, why: `Step ${at} of ${STEPS.length}` };
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
          {next("Start a thread here")}
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
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogPopup data-add-computer={screen} initialFocus={screen === "where" || screen === "hostkey" ? undefined : false} className="max-w-[560px] [--settings-inset:16px] sm:h-[640px]">
        <div className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="flex-row items-start justify-between gap-6 pb-3">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle>{head.title}</DialogTitle>
              <DialogDescription>{head.line}</DialogDescription>
            </div>
            <span data-k="progress" className={cn(FACT, "shrink-0 pt-0.5")} title={at.why}>
              {at.words}
            </span>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5 pt-2 pb-5">{body(screen)}</DialogPanel>
          <DialogFooter className="pt-2">{foot(screen)}</DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
