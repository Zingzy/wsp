// SPDX-License-Identifier: AGPL-3.0-only
// The lists a person ticks what goes on a computer from: agents with how each
// signs in there, MCP servers, CLIs with their size, skills, plugins, the
// projects to import with their name, icon and colour, GitHub, and the other
// config. Add a computer draws one per step; a recipe's page draws them one
// under another. Each row is what the computer running the host offers, ticked
// where the picks hold it.
import { GitCommitHorizontalIcon, GithubIcon, PlugIcon, PuzzleIcon, ScrollTextIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { HERE_PLACE_ID, fmtBytes, hereName, sizeTone, type GitHubSignIn, type ProjectHue, type ProjectIcon, type RecipeFile, type RecipeOptions, type RecipeSignIn } from "@wsp/protocol";
import { AgentMarks } from "../../components/agents/agentsParts.js";
import { useAgentsReport } from "../../components/agents/useAgentsReport.js";
import { HarnessMark } from "../../components/chat/HarnessMark.js";
import { Input } from "../../components/ui/input.js";
import { Radio, RadioGroup } from "../../components/ui/radio-group.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { cn } from "../../lib/utils.js";
import { useStore } from "../../protocol/store.js";
import { PROJECT_GLYPHS, PROJECT_HUES } from "../../projects/look.js";
import { HueSelect, IconSelect } from "../../projects/LookPicker.js";
import { signInSentence } from "../agents.js";
import { ADD_COMPUTER_WORDS, FACT } from "../format.js";
import { GlyphFrame, Grid } from "../grid.js";
import { CARD_INSET, LIST_TITLE, NOTE, ROW_FIELD, ROW_FLOOR, SELECT_WIDTH } from "../layout.js";
import { SizeCell } from "../recipe/rows.js";
import { githubPick, setGitHub, signIn, tick, tickConfig, tickFolder } from "./choices.js";
import { PickLine, PickRow } from "./PickRow.js";

const GLYPH = "size-4 text-foreground/80";

/** What every list takes: the picks, what they are made from, and where a changed pick goes. */
export interface PickProps {
  picks: RecipeFile;
  options: RecipeOptions;
  onChange: (next: RecipeFile) => void;
  /** The computer the picks go on, by name, for the words that name it. */
  box: string;
  /** Rows the picks do not hold are left out: a recipe's page lists what it holds. */
  onlyTicked?: boolean;
}

/** A size in the weight table's ink, drawn only where the host measured the row. */
export function Size({ bytes }: { bytes: number | undefined }) {
  if (bytes === undefined) return null;
  return (
    <SizeCell tone={sizeTone(bytes)} className="text-[13px]">
      {fmtBytes(bytes)}
    </SizeCell>
  );
}

/** What signing in on the computer adds to its words, by how the agent's own sign-in works: a device code is typed
 * on a page, where a browser sign-in only opens a tab. */
const MACHINE_TAIL: Readonly<Record<string, string>> = { device: " with a code" };

/** What each way of signing in is called in the picker, for an agent that signs in the way `kind` names. */
const signInWords = (box: string, kind: string | undefined): Record<RecipeSignIn, string> => ({
  vault: "Copy the key",
  machine: `${box === "" ? "Sign in there" : `Sign in on ${box}`}${(kind === undefined ? undefined : MACHINE_TAIL[kind]) ?? ""}`,
});

/** The agents; on a recipe's page each ticked one says how it signs in as its note rather than a picker. */
export function AgentsPicks({ picks, options, onChange, box, versions, onlyTicked = false, wayAsNote = false }: PickProps & { versions?: Record<string, string>; wayAsNote?: boolean }) {
  // Where the picks are made, each agent says how it is signed in on the computer running the host.
  const { report } = useAgentsReport(wayAsNote ? null : { placeId: HERE_PLACE_ID });
  const here = useStore(s => hereName(s.places));
  return (
    <Grid id="agents">
      {options.agents
        .filter(agent => !onlyTicked || picks.agents[agent.id] !== undefined)
        .map(agent => {
          const on = picks.agents[agent.id] !== undefined;
          const words = signInWords(box, agent.kind);
          const way = picks.agents[agent.id]?.signin ?? agent.signins[0] ?? "vault";
          const version = versions?.[agent.id];
          const row = report?.agents.find(a => a.id === agent.id && a.installed);
          const note = on && wayAsNote ? words[way] : row === undefined ? undefined : signInSentence(row, here);
          const select =
            on && !wayAsNote && agent.signins.length > 0 ? (
              <Select value={way} onValueChange={next => onChange(signIn(picks, agent.id, next as RecipeSignIn))}>
                <SelectTrigger size="sm" aria-label={`${agent.name} sign-in`} className={SELECT_WIDTH}>
                  <SelectValue>{(value: RecipeSignIn) => words[value]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {agent.signins.map(w => (
                    <SelectItem key={w} value={w}>
                      {words[w]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null;
          return (
            <PickRow
              key={agent.id}
              id={agent.id}
              checked={on}
              onCheckedChange={next => onChange(tick(picks, "agents", agent.id, next, options))}
              glyph={<HarnessMark harness={agent.id} label={agent.name} className="size-5" />}
              name={agent.name}
              {...(version === undefined ? {} : { tag: version })}
              {...(note === undefined ? {} : { note })}
              {...(select === null && agent.bytes === undefined
                ? {}
                : {
                    slot: (
                      <>
                        <Size bytes={agent.bytes} />
                        {select}
                      </>
                    ),
                  })}
            />
          );
        })}
    </Grid>
  );
}

/** The servers, each saying how it signs in on the computer, as an agent's row says it. */
export function ServersPicks({ picks, options, onChange, box, onlyTicked = false }: PickProps) {
  return (
    <Grid id="servers">
      {options.mcp
        .filter(server => !onlyTicked || picks.mcp[server.name] !== undefined)
        .map(server => (
          <PickRow
            key={server.name}
            id={server.name}
            checked={picks.mcp[server.name] !== undefined}
            onCheckedChange={next => onChange(tick(picks, "mcp", server.name, next, options))}
            glyph={<PlugIcon aria-hidden className={GLYPH} />}
            name={server.name}
            marks={<AgentMarks agents={server.agents} />}
            {...(server.kind === undefined ? {} : { note: ADD_COMPUTER_WORDS.serverSignIn(server.kind, box) })}
          />
        ))}
    </Grid>
  );
}

export function ClisPicks({ picks, options, onChange, onlyTicked = false }: PickProps) {
  return (
    <Grid id="clis">
      {options.clis
        .filter(cli => !onlyTicked || picks.clis[cli.name] !== undefined)
        .map(cli => (
          <PickRow
            key={cli.name}
            id={cli.name}
            checked={picks.clis[cli.name] !== undefined}
            onCheckedChange={next => onChange(tick(picks, "clis", cli.name, next, options))}
            glyph={<TerminalIcon aria-hidden className={GLYPH} />}
            name={cli.name}
            {...(cli.version === undefined ? {} : { tag: cli.version })}
            note={cli.needs === undefined ? cli.via : `${cli.via}. Needs ${cli.needs.join(", ")}.`}
            {...(cli.bytes === undefined ? {} : { slot: <Size bytes={cli.bytes} /> })}
          />
        ))}
    </Grid>
  );
}

/** The skills, or on a recipe's page the first few it holds and how many more. */
export function SkillsPicks({ picks, options, onChange, onlyTicked = false, first }: PickProps & { first?: number }) {
  const rows = options.skills.filter(item => !onlyTicked || picks.skills[item.name] !== undefined);
  const shown = first === undefined ? rows : rows.slice(0, first);
  return (
    <Grid id="skills">
      {shown.map(item => (
        <PickRow key={item.name} id={item.name} checked={picks.skills[item.name] !== undefined} onCheckedChange={next => onChange(tick(picks, "skills", item.name, next, options))} glyph={<ScrollTextIcon aria-hidden className={GLYPH} />} name={item.name} slot={<span className={FACT}>{item.from}</span>} />
      ))}
      {rows.length > shown.length ? (
        <div data-k="more-skills" className={cn("flex items-center py-3", CARD_INSET, "min-h-12")}>
          <span className={NOTE}>{rows.length - shown.length} more skills on this recipe.</span>
        </div>
      ) : null}
    </Grid>
  );
}

export function PluginsPicks({ picks, options, onChange, onlyTicked = false }: PickProps) {
  return (
    <Grid id="plugins">
      {options.plugins
        .filter(plugin => !onlyTicked || picks.plugins[plugin.name] !== undefined)
        .map(plugin => {
          const at = plugin.name.lastIndexOf("@");
          return (
            <PickRow key={plugin.name} id={plugin.name} checked={picks.plugins[plugin.name] !== undefined} onCheckedChange={next => onChange(tick(picks, "plugins", plugin.name, next, options))} glyph={<PuzzleIcon aria-hidden className={GLYPH} />} name={at > 0 ? plugin.name.slice(0, at) : plugin.name} {...(at > 0 ? { tag: plugin.name.slice(at + 1) } : {})} />
          );
        })}
    </Grid>
  );
}

/** A radio list in the card: the radio, the mark in its frame, the name over a note, a fact at the right. */
export function Choice({ id, picked, glyph, name, note, fact }: { id: string; picked: boolean; glyph: ReactNode; name: string; note?: string; fact?: string }) {
  return (
    <label data-choice={id} className={cn("flex cursor-pointer items-center gap-3 py-3", CARD_INSET, ROW_FLOOR)}>
      <Radio value={id} />
      <GlyphFrame>{glyph}</GlyphFrame>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(LIST_TITLE, "min-w-0 break-words", !picked && "text-muted-foreground")}>{name}</span>
        {note === undefined ? null : <span className={NOTE}>{note}</span>}
      </span>
      {fact === undefined ? null : <span className={cn(FACT, "shrink-0")}>{fact}</span>}
    </label>
  );
}

/** GitHub: the ways the host says it can sign gh in there, the token gh holds on the computer running the host only
 * where it holds one, signing in there, or skipping it for now. */
export function GitHubPicks({ picks, options, onChange, box, here }: PickProps & { here: string }) {
  const picked = githubPick(picks);
  const words: Record<GitHubSignIn, { name: string; note?: string }> = {
    vault: { name: `Use the token from ${here}` },
    machine: { name: `Sign in on ${box}`, note: "A tab opens in your browser here." },
    skip: { name: ADD_COMPUTER_WORDS.skipForNow, note: "Private repos will not clone until you sign in. You can do it later in Settings." },
  };
  const choices = (options.configs.find(c => c.id === "github")?.signins ?? []).map(id => ({ id, ...words[id] }));
  return (
    <RadioGroup value={picked} onValueChange={next => onChange(setGitHub(picks, next as GitHubSignIn))} className="gap-0">
      <Grid id="github">
        {choices.map(choice => (
          <Choice key={choice.id} id={choice.id} picked={picked === choice.id} glyph={<GithubIcon aria-hidden className={GLYPH} />} name={choice.name} {...(choice.note === undefined ? {} : { note: choice.note })} />
        ))}
      </Grid>
    </RadioGroup>
  );
}

const CONFIG_ROWS = [
  { id: "git", name: "Git", glyph: GitCommitHorizontalIcon },
  { id: "shell", name: "Shell", glyph: SquareTerminalIcon },
] as const;

export function OtherPicks({ picks, options, onChange, onlyTicked = false }: PickProps) {
  return (
    <Grid id="configs">
      {CONFIG_ROWS.flatMap(row => {
        const offered = options.configs.find(c => c.id === row.id);
        if (offered === undefined || (onlyTicked && picks.configs[row.id] === undefined)) return [];
        const Glyph = row.glyph;
        return [<PickRow key={row.id} id={row.id} checked={picks.configs[row.id] !== undefined} onCheckedChange={next => onChange(tickConfig(picks, row.id, next))} glyph={<Glyph aria-hidden className={GLYPH} />} name={row.name} note={offered.label} />];
      })}
    </Grid>
  );
}

/** One folder a person may import: a project of the computer running the host, or a folder they picked. */
export interface FolderOption {
  key: string;
  name: string;
  path: string;
  remote?: string;
  icon: ProjectIcon;
  hue: ProjectHue;
  bytes?: number;
  /** GitHub refuses an anonymous read of its repository: the box clones it only with GitHub signed in there. */
  private?: boolean;
  /** Commits no remote holds. */
  unpushed?: number;
}

/** What a project's row says of its repository: its remote and what of it is not pushed, or that it has none. A folder
 * whose remote nobody read says nothing. */
const folderNote = (folder: FolderOption): string | undefined =>
  folder.remote === undefined ? undefined : folder.remote === "" ? ADD_COMPUTER_WORDS.noRemote : ADD_COMPUTER_WORDS.remoteLine(folder.remote, folder.unpushed);

/** The projects to import: a ticked one opens its name, icon and colour. A name the computer already has a project
 * by is the one state that questions the field. */
export function ProjectsPicks({ picks, onChange, box, folders, taken }: Omit<PickProps, "options"> & { folders: readonly FolderOption[]; taken: (name: string) => boolean }) {
  const noGitHub = githubPick(picks) === "skip";
  return (
    <Grid id="projects">
      {folders.map(folder => {
        const row = picks.folders[folder.key];
        const name = row?.name ?? folder.name;
        const icon = row?.icon ?? folder.icon;
        const hue = row?.hue ?? folder.hue;
        const Glyph = PROJECT_GLYPHS[icon];
        const clash = row !== undefined && taken(name);
        const note = row !== undefined && noGitHub && folder.private === true ? ADD_COMPUTER_WORDS.needsGitHub : folderNote(folder);
        const put = (next: Partial<RecipeFile["folders"][string]>): void => onChange(tickFolder(picks, folder.key, { from: folder.path, name, icon, hue, keep: row?.keep ?? [], ...next }));
        return (
          <PickRow
            key={folder.key}
            id={folder.key}
            checked={row !== undefined}
            onCheckedChange={next => (next ? put({}) : onChange(tickFolder(picks, folder.key, undefined)))}
            glyph={<Glyph aria-hidden className={cn("size-4", hue === "neutral" ? "text-foreground/80" : PROJECT_HUES[hue].text)} />}
            name={name}
            tag={folder.path}
            {...(note === undefined ? {} : { note })}
            {...(folder.bytes === undefined ? {} : { slot: <Size bytes={folder.bytes} /> })}
          >
            {row === undefined ? null : (
              <>
                <PickLine label="Name">
                  <span className="flex flex-col items-end gap-1">
                    <Input data-k="project-name" aria-label="Project name" aria-invalid={clash || undefined} value={name} onChange={e => put({ name: e.target.value })} className={cn(ROW_FIELD, "w-44 max-sm:w-36")} />
                    {clash ? (
                      <span data-k="name-taken" className="text-[13px] leading-[18px] text-destructive-foreground">
                        {box} already has a project called {name}.
                      </span>
                    ) : null}
                  </span>
                </PickLine>
                <PickLine label="Icon">
                  <IconSelect icon={icon} hue={hue} onChange={next => put({ icon: next })} />
                </PickLine>
                <PickLine label="Colour">
                  <HueSelect hue={hue} onChange={next => put({ hue: next })} />
                </PickLine>
              </>
            )}
          </PickRow>
        );
      })}
    </Grid>
  );
}
