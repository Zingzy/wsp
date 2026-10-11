// SPDX-License-Identifier: AGPL-3.0-only
// The lists a person ticks what goes on a computer from: agents with how each
// signs in there, MCP servers, CLIs with their size, skills, plugins, the
// projects to import with their name, icon and colour, GitHub, and the other
// config. Add a computer draws one per step; a recipe's page draws them one
// under another. Each row is what the computer running the host offers, ticked
// where the picks hold it.
import { GitCommitHorizontalIcon, GithubIcon, KeyRoundIcon, PlugIcon, PuzzleIcon, ScrollTextIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { HERE_PLACE_ID, fmtBytes, fmtCalls, hereName, signInWayDoes, signInWayLabel, sizeTone, type GitHubSignIn, type ProjectHue, type ProjectIcon, type RecipeFile, type RecipeOptions, type RecipeSignIn } from "@wsp/protocol";
import { catalogEntry, keyEnvOf, mintsToken } from "@wsp/catalog";
import { AgentMarks } from "../../components/agents/agentsParts.js";
import { catalogSignInRow } from "../../components/agents/agentsRows.js";
import { useAgentsReport } from "../../components/agents/useAgentsReport.js";
import { HarnessMark } from "../../components/chat/HarnessMark.js";
import { Input } from "../../components/ui/input.js";
import { Radio, RadioGroup } from "../../components/ui/radio-group.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { cn } from "../../lib/utils.js";
import { useStore } from "../../protocol/store.js";
import { ProjectGlyph } from "../../projects/look.js";
import { HueSelect, IconSelect } from "../../projects/LookPicker.js";
import { signInSentence } from "../agents.js";
import { ADD_COMPUTER_WORDS, FACT } from "../format.js";
import { GlyphFrame, Grid } from "../grid.js";
import { CARD_INSET, LIST_TITLE, NOTE, ROW_FIELD, ROW_FLOOR, SELECT_WIDTH } from "../layout.js";
import { SizeCell } from "../recipe/rows.js";
import { copiesKeys, githubPick, keyedServers, setCopyKeys, setGitHub, signIn, tickConfig, tickFolder, tickMany } from "./choices.js";
import { PickList, RANGE_HOVER, type PickChanges } from "./PickList.js";
import { PickLine, PickRow } from "./PickRow.js";

const GLYPH = "size-4 text-foreground/80";

/** The order a list's rows come in where it is neither by name nor by use: the catalog's for agents, the projects'. */
const AS_FOUND = "As found";

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
  token: signInWayLabel("token", box),
  key: signInWayLabel("key", box),
});

/** What a row picked to take a token or a key says it does, the same words its failed row's fix opens each way with. */
const wayNote = (agent: string, name: string, way: "token" | "key", here: string, box: string): string => {
  const s = catalogEntry(agent)?.signIn;
  const keyEnv = s === undefined ? undefined : keyEnvOf(s);
  const does = signInWayDoes(way, { name, here, box, ...(s !== undefined && mintsToken(s) ? { mint: s.mint } : {}), ...(keyEnv !== undefined ? { keyEnv } : {}) });
  // The token's sentence opens with the command that makes it, which keeps its own case.
  return way === "token" ? `${does}.` : `${does.charAt(0).toUpperCase()}${does.slice(1)}.`;
};

/** The agents; on a recipe's page each ticked one says how it signs in as its note rather than a picker. */
export function AgentsPicks({ picks, options, onChange, box, versions, onlyTicked = false, wayAsNote = false }: PickProps & { versions?: Record<string, string>; wayAsNote?: boolean }) {
  // Where the picks are made, each agent says how it is signed in on the computer running the host.
  const { report } = useAgentsReport(wayAsNote ? null : { placeId: HERE_PLACE_ID });
  const here = useStore(s => hereName(s.places));
  const items = options.agents.filter(agent => !onlyTicked || picks.agents[agent.id] !== undefined).map(agent => ({ key: agent.id, name: agent.name, on: picks.agents[agent.id] !== undefined, agent }));
  const tools = !onlyTicked && !wayAsNote;
  return (
    <PickList
      id="agents"
      items={items}
      own={AS_FOUND}
      tools={tools}
      onSet={changes => onChange(tickMany(picks, "agents", changes, options))}
      row={({ agent, on }, tick) => {
        const words = signInWords(box, agent.kind);
        const way = picks.agents[agent.id]?.signin ?? agent.signins[0] ?? "vault";
        const version = versions?.[agent.id];
        const row = report?.agents.find(a => a.id === agent.id && a.installed);
        // Ticked with no way this computer can serve but its own road, it says that road: the token or key pasted on
        // its row, or its terminal on the computer, which no setup sits at.
        const road = on && !wayAsNote && agent.signins.every(w => w === "machine") ? catalogSignInRow(agent.id)?.signInRoad : undefined;
        const note =
          on && !wayAsNote && (way === "token" || way === "key")
            ? wayNote(agent.id, agent.name, way, here, box)
            : road === "token" || road === "key"
            ? ADD_COMPUTER_WORDS.pasteOnceSetUp(road)
            : road === "terminal"
              ? ADD_COMPUTER_WORDS.atItsTerminalOnceSetUp(box === "" ? "that computer" : box)
              : on && wayAsNote
                ? words[way]
                : row === undefined
                  ? undefined
                  : signInSentence(row, here);
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
            onCheckedChange={tick}
            {...(tools ? { hover: RANGE_HOVER } : {})}
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
      }}
    />
  );
}

/** The servers, each saying how it signs in on the computer, as an agent's row says it, and under them the one question
 * about the keys the ticked ones carry. */
export function ServersPicks({ picks, options, onChange, box, onlyTicked = false }: PickProps) {
  const items = options.mcp.filter(server => !onlyTicked || picks.mcp[server.name] !== undefined).map(server => ({ key: server.name, name: server.name, on: picks.mcp[server.name] !== undefined, server }));
  const copied = copiesKeys(picks);
  return (
    <>
      <PickList
        id="servers"
        items={items}
        tools={!onlyTicked}
        onSet={changes => onChange(tickMany(picks, "mcp", changes, options))}
        row={({ server, on }, tick) => (
          <PickRow
            key={server.name}
            id={server.name}
            checked={on}
            onCheckedChange={tick}
            {...(onlyTicked ? {} : { hover: RANGE_HOVER })}
            glyph={<PlugIcon aria-hidden className={GLYPH} />}
            name={server.name}
            marks={<AgentMarks agents={server.agents} />}
            {...(on && (server.keys?.length ?? 0) > 0 && !copied ? { note: ADD_COMPUTER_WORDS.keysStay } : server.kind === undefined ? {} : { note: ADD_COMPUTER_WORDS.serverSignIn(server.kind, box) })}
          />
        )}
      />
      <ServerKeysPick picks={picks} options={options} onChange={onChange} box={box} />
    </>
  );
}

/** Copy the keys the ticked servers carry to the computer, or leave them here, which sets those servers aside there.
 * Asked once for every such server, each named with what its keys go by and never a value. */
function ServerKeysPick({ picks, options, onChange, box }: PickProps) {
  const here = useStore(s => hereName(s.places));
  const keyed = keyedServers(picks, options);
  if (keyed.length === 0) return null;
  const picked = copiesKeys(picks) ? "copy" : "leave";
  return (
    <RadioGroup value={picked} onValueChange={next => onChange(setCopyKeys(picks, next === "copy"))} className="gap-0">
      <Grid id="server-keys">
        <Choice id="copy" picked={picked === "copy"} glyph={<KeyRoundIcon aria-hidden className={GLYPH} />} name={ADD_COMPUTER_WORDS.copyKeys(box)} note={ADD_COMPUTER_WORDS.keysNamed(keyed)} />
        <Choice id="leave" picked={picked === "leave"} glyph={<KeyRoundIcon aria-hidden className={GLYPH} />} name={ADD_COMPUTER_WORDS.leaveKeys(here)} note={ADD_COMPUTER_WORDS.keysLeft(keyed.map(s => s.name), box)} />
      </Grid>
    </RadioGroup>
  );
}

/** The CLIs, the ones the agents ran most first, each with how many times they ran it; one never run says nothing. */
export function ClisPicks({ picks, options, onChange, onlyTicked = false }: PickProps) {
  const items = options.clis
    .filter(cli => !onlyTicked || picks.clis[cli.name] !== undefined)
    .sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0))
    .map(cli => ({ key: cli.name, name: cli.name, on: picks.clis[cli.name] !== undefined, cli }));
  return (
    <PickList
      id="clis"
      items={items}
      own="Most used"
      tools={!onlyTicked}
      onSet={changes => onChange(tickMany(picks, "clis", changes, options))}
      row={({ cli, on }, tick) => (
        <PickRow
          key={cli.name}
          id={cli.name}
          checked={on}
          onCheckedChange={tick}
          {...(onlyTicked ? {} : { hover: RANGE_HOVER })}
          glyph={<TerminalIcon aria-hidden className={GLYPH} />}
          name={cli.name}
          {...(cli.version === undefined ? {} : { tag: cli.version })}
          note={cli.needs === undefined ? cli.via : `${cli.via}. Needs ${cli.needs.join(", ")}.`}
          {...(cli.calls === undefined && cli.bytes === undefined
            ? {}
            : {
                slot: (
                  <>
                    {cli.calls === undefined ? null : (
                      <span data-k="cli-calls" className={FACT}>
                        {fmtCalls(cli.calls)}
                      </span>
                    )}
                    {/* The sizes run from "1 MB" to "517 MB": a column as wide as the widest keeps every count on one edge. */}
                    <span className="sm:min-w-14 sm:text-right">
                      <Size bytes={cli.bytes} />
                    </span>
                  </>
                ),
              })}
        />
      )}
    />
  );
}

/** The skills, or on a recipe's page the first few it holds and how many more. */
export function SkillsPicks({ picks, options, onChange, onlyTicked = false, first }: PickProps & { first?: number }) {
  const rows = options.skills.filter(item => !onlyTicked || picks.skills[item.name] !== undefined);
  const shown = first === undefined ? rows : rows.slice(0, first);
  return (
    <PickList
      id="skills"
      items={shown.map(item => ({ key: item.name, name: item.name, on: picks.skills[item.name] !== undefined, item }))}
      tools={!onlyTicked}
      onSet={changes => onChange(tickMany(picks, "skills", changes, options))}
      row={({ item, on }, tick) => <PickRow key={item.name} id={item.name} checked={on} onCheckedChange={tick} {...(onlyTicked ? {} : { hover: RANGE_HOVER })} glyph={<ScrollTextIcon aria-hidden className={GLYPH} />} name={item.name} slot={<span className={FACT}>{item.from}</span>} />}
    >
      {rows.length > shown.length ? (
        <div data-k="more-skills" className={cn("flex items-center py-3", CARD_INSET, "min-h-12")}>
          <span className={NOTE}>{rows.length - shown.length} more skills on this recipe.</span>
        </div>
      ) : null}
    </PickList>
  );
}

export function PluginsPicks({ picks, options, onChange, onlyTicked = false }: PickProps) {
  const items = options.plugins.filter(plugin => !onlyTicked || picks.plugins[plugin.name] !== undefined).map(plugin => ({ key: plugin.name, name: plugin.name, on: picks.plugins[plugin.name] !== undefined }));
  return (
    <PickList
      id="plugins"
      items={items}
      tools={!onlyTicked}
      onSet={changes => onChange(tickMany(picks, "plugins", changes, options))}
      row={({ key, on }, tick) => {
        const at = key.lastIndexOf("@");
        return <PickRow key={key} id={key} checked={on} onCheckedChange={tick} {...(onlyTicked ? {} : { hover: RANGE_HOVER })} glyph={<PuzzleIcon aria-hidden className={GLYPH} />} name={at > 0 ? key.slice(0, at) : key} {...(at > 0 ? { tag: key.slice(at + 1) } : {})} />;
      }}
    />
  );
}

/** A radio list in the card: the radio, the mark in its frame where the choice has one, the name over a note, and
 * at the right a fact or the one control. Below 640 px the control stands under the words, as a row's does. */
export function Choice({ id, picked, glyph, name, note, fact, slot, hover, attrs, title = LIST_TITLE }: { id: string; picked: boolean; glyph?: ReactNode; name: string; note?: string; fact?: string; slot?: ReactNode; /** One sentence on hover: the keys that pick the row. */ hover?: string; attrs?: Record<string, string>; /** The name's type, as PickRow takes it. */ title?: string }) {
  return (
    <label data-choice={id} {...(hover === undefined ? {} : { title: hover })} {...attrs} className={cn("flex cursor-pointer flex-col justify-center gap-3 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-5", CARD_INSET, ROW_FLOOR)}>
      <span className="flex min-w-0 items-center gap-3">
        <Radio value={id} />
        {glyph === undefined ? null : <GlyphFrame>{glyph}</GlyphFrame>}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn(title, "min-w-0 break-words", !picked && "text-muted-foreground")}>{name}</span>
          {note === undefined ? null : <span className={NOTE}>{note}</span>}
        </span>
        {fact === undefined ? null : <span className={cn(FACT, "shrink-0")}>{fact}</span>}
      </span>
      {slot === undefined ? null : (
        <span data-choice-slot className="flex min-w-0 shrink-0 items-center gap-3 max-sm:pl-7 sm:justify-end" onClick={event => event.preventDefault()}>
          {slot}
        </span>
      )}
    </label>
  );
}

/** GitHub: the ways the host says it can sign gh in there, the token gh holds on the computer running the host only
 * where it holds one, signing in there, or skipping it for now. */
export function GitHubPicks({ picks, options, onChange, box, here }: PickProps & { here: string }) {
  const picked = githubPick(picks);
  const offered = options.configs.find(c => c.id === "github");
  const words: Record<GitHubSignIn, { name: string; note?: string }> = {
    vault: { name: `Use the token from ${here}`, ...(offered?.account === undefined ? {} : { note: ADD_COMPUTER_WORDS.githubAccount(offered.account, offered.scopes ?? []) }) },
    machine: { name: `Sign in on ${box}`, note: "A tab opens in your browser here." },
    skip: { name: ADD_COMPUTER_WORDS.skipForNow, note: "Private repos will not clone until you sign in. You can do it later in Settings." },
  };
  const choices = (offered?.signins ?? []).map(id => ({ id, ...words[id] }));
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
  const items = CONFIG_ROWS.flatMap(row => {
    const offered = options.configs.find(c => c.id === row.id);
    if (offered === undefined || (onlyTicked && picks.configs[row.id] === undefined)) return [];
    return [{ key: row.id, name: row.name, on: picks.configs[row.id] !== undefined, row, label: offered.label }];
  });
  const set = (changes: PickChanges): void => onChange(changes.reduce((next, [id, on]) => tickConfig(next, id as "git" | "shell", on), picks));
  return (
    <PickList
      id="configs"
      items={items}
      tools={!onlyTicked}
      onSet={set}
      row={({ row, label, on }, tick) => {
        const Glyph = row.glyph;
        return <PickRow key={row.id} id={row.id} checked={on} onCheckedChange={tick} {...(onlyTicked ? {} : { hover: RANGE_HOVER })} glyph={<Glyph aria-hidden className={GLYPH} />} name={row.name} note={label} />;
      }}
    />
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
  /** The hash of the image the project wears here, which its row and the project the box gets wear too. */
  image?: string;
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
  const rowOf = (folder: FolderOption): RecipeFile["folders"][string] & { name: string; icon: ProjectIcon; hue: ProjectHue } => {
    const row = picks.folders[folder.key];
    const image = row === undefined ? folder.image : row.image;
    return { from: folder.path, name: row?.name ?? folder.name, icon: row?.icon ?? folder.icon, hue: row?.hue ?? folder.hue, ...(image === undefined ? {} : { image }), keep: row?.keep ?? [] };
  };
  const set = (changes: PickChanges): void =>
    onChange(
      changes.reduce((next, [key, on]) => {
        const folder = folders.find(f => f.key === key);
        return folder === undefined ? next : tickFolder(next, key, on ? rowOf(folder) : undefined);
      }, picks),
    );
  const items = folders.map(folder => ({ key: folder.key, name: picks.folders[folder.key]?.name ?? folder.name, on: picks.folders[folder.key] !== undefined, folder }));
  return (
    <PickList
      id="projects"
      items={items}
      own={AS_FOUND}
      onSet={set}
      row={({ folder, on }, tick) => {
        const { name, icon, hue, image } = rowOf(folder);
        const clash = on && taken(name);
        const note = on && noGitHub && folder.private === true ? ADD_COMPUTER_WORDS.needsGitHub : folderNote(folder);
        const put = (next: Partial<RecipeFile["folders"][string]>): void => onChange(tickFolder(picks, folder.key, { ...rowOf(folder), ...next }));
        return (
          <PickRow
            key={folder.key}
            id={folder.key}
            checked={on}
            onCheckedChange={tick}
            hover={RANGE_HOVER}
            glyph={<ProjectGlyph look={{ icon, hue, image }} ink="text-foreground/80" />}
            name={name}
            tag={folder.path}
            {...(note === undefined ? {} : { note })}
            {...(folder.bytes === undefined ? {} : { slot: <Size bytes={folder.bytes} /> })}
          >
            {!on ? null : (
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
                  <IconSelect
                    icon={icon}
                    hue={hue}
                    {...(image === undefined ? {} : { image: <ProjectGlyph look={{ icon, hue, image }} /> })}
                    onChange={next => {
                      // A glyph picked is the glyph wanted, so the image the row carried goes.
                      const { image: _image, ...plain } = rowOf(folder);
                      onChange(tickFolder(picks, folder.key, { ...plain, icon: next }));
                    }}
                  />
                </PickLine>
                <PickLine label="Colour">
                  <HueSelect hue={hue} onChange={next => put({ hue: next })} />
                </PickLine>
              </>
            )}
          </PickRow>
        );
      }}
    />
  );
}
