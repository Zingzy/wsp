// SPDX-License-Identifier: AGPL-3.0-only
import { TOOL_PREFIX, installEnv, installHomes } from "@wsp/catalog";
import { type Machine, GUEST_USER_ENV, TOOLS_PATH } from "@wsp/engine";
import type { KeptAgent } from "@wsp/protocol";
import type {
  AdapterAttachOptions,
  AdapterEvent,
  AttachmentRoad,
  ExecStreamFactory,
  HarnessCatalogAnswer,
  HarnessExec,
  ScreenCommand,
  PermissionOutcome,
  SessionRenamer,
  SessionAsker,
  SessionReverter,
  SessionTitleMaker,
  SessionTitleReader,
  McpServerSpec,
  TurnImage,
  TurnResult,
} from "@wsp/protocol";
import type { CommitDrafter } from "@wsp/protocol";
import { PLACE_WORKSPACE_PATH, onNpmBin } from "@wsp/protocol";
import type { TaskStop } from "@wsp/protocol";
import type { AccessChoice, AgentLaunch } from "@wsp/protocol";

// --- adapter port -------------------------------------------------------------

export interface HarnessAdapterContext {
  machine: Machine;
  workspaceId: string;
  /** How a turn's process is launched on this machine: the guest's detached-and-polled road on a cloud fork, a real
   * child process on the local computer. The one concern that varies by machine kind and reaches the adapter here. */
  execStream: ExecStreamFactory;
  /** Where the harness keeps its sessions on this machine, by agent id: the folder the golden's sign-in wrote into on
   * a cloud fork, the person's own store on the local computer. */
  home: (agentId: string) => string;
  /** The machine's login environment, exported under the harness's own on every launch: the golden's PATH, so a
   * launch served by a process with a bare one still finds the binary, and on a guest the variable that points this
   * harness at its store there. On the person's own computer it is their shell's, so a store variable is set only
   * where their shell sets it, and their login is the turn's login. */
  env: Readonly<Record<string, string>>;
  /** What this agent keys its sessions and its auto memory to on this workspace, where the kind has an answer: the
   * project's own key on a machine, a worktree's own key in a worktree wsp made here, and for any other folder here
   * the key the person's own agent gives it, so the two share its memory. Absent leaves the agent keying off the
   * folder each turn runs in. */
  projectKey?: string;
  /** wsp's half of a turn this workspace's agent refuses for want of a sign-in, from the one rule every door reads
   * for how it is signed in: it differs between the person's own computer and a machine, which the adapter cannot
   * know, so it is told the road from here rather than guessing one. */
  signInRefusal: string;
  /** The tokens and API keys the vault holds, by variable. Its own field rather than part of `env`: the Claude
   * adapter strips every inherited CLAUDE_CODE_* off the base environment as a nesting mark, so a token merged
   * into the environment would be stripped and never reach the CLI. Empty where the host wired no vault. */
  vault: Readonly<Record<string, string>>;
  /** Whether a login of one agent's own already stands where this workspace runs, which is what decides whether
   * the vault's key for it is handed to the turn: a harness reads a key in its environment ahead of the login on
   * its disk, so handing one where a person signed in would bill the key and leave that sign-in unused. Where a
   * login lives differs by machine kind, which the adapter cannot know, so it is told from here. */
  loginStands: (agentId: string) => boolean;
  /** The program the person runs in place of this agent on the workspace's computer, and the words each turn's launch
   * adds; absent runs the agent's own command as it is. */
  launch?: AgentLaunch;
}

/** What every machine wsp runs agents on tells them, cloud fork and ssh machine alike, and this computer never does:
 * IS_SANDBOX=1 is what lets Claude Code take --dangerously-skip-permissions as root there (solari-poc P1).
 * DISABLE_AUTOUPDATER=1 holds the agent at the version the image pinned, inside a fork or a box, at run time too. */
export const MACHINE_SANDBOX_ENV: Readonly<Record<string, string>> = { IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1" };

/** The guest's login environment: who it runs as, the PATH the golden's login shells get, and the sandbox flag every
 * machine carries. Every fork carries it in its envs at create and every adapter exports it under the harness's own. */
export const GUEST_LOGIN_ENV: Readonly<Record<string, string>> = { ...GUEST_USER_ENV, PATH: TOOLS_PATH, ...MACHINE_SANDBOX_ENV };

/** The same for a workspace on a computer somebody joined: the order that reads the folders no process inside can
 * write before the home every workspace there shares, and beside it the knobs the recipe's job installed under,
 * off the catalog's one table. A thread, a command and the workspace's own boot carry this, so a tool the recipe
 * put under wsp's prefix is the one that answers inside wherever it is asked for. A fork keeps GUEST_LOGIN_ENV:
 * its home is root's alone, and its image was sealed on that order with each manager's own folders. */
export const PLACE_LOGIN_ENV: Readonly<Record<string, string>> = {
  ...GUEST_USER_ENV,
  PATH: PLACE_WORKSPACE_PATH,
  ...MACHINE_SANDBOX_ENV,
  ...installEnv(installHomes(TOOL_PREFIX)),
};

/** Which of the two a workspace runs on: where it stands, with the folder npm's global installs went to ahead of its
 * PATH where the image it was forked from read one at the seal. */
export const loginEnvOn = (place: string | undefined, npmBin?: string): Readonly<Record<string, string>> => {
  const login = place === undefined ? GUEST_LOGIN_ENV : PLACE_LOGIN_ENV;
  return npmBin === undefined ? login : { ...login, PATH: onNpmBin(npmBin, login["PATH"]!) };
};

export interface HarnessStartOptions {
  prompt: string;
  resume?: string;
  cwd?: string;
  /** Catalog slugs the adapter maps to its CLI's flags; absent leaves the CLI's default. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  /** The model's faster output for this turn, where the catalog marks the model as having one. */
  fast?: boolean;
  /** The name the thread is opened under, for a CLI that takes one at launch; every harness is told it again through
   * renameSession once its session is announced, so an adapter whose CLI cannot take it here need not. */
  title?: string;
  /** The turn's images, each already on the road its adapter declared: bytes for an inline adapter, a path on the
   * machine for a file one. Empty on a turn that carries none. */
  images?: readonly TurnImage[];
  /** On the first resume after a rewind, on a harness that cuts there: the anchor of the turn the rewind kept. */
  resumeAt?: string;
  /** MCP servers this turn gets besides the ones the harness's own config on the machine names, by the name each
   * takes in a config; the adapter hands them to its CLI the way that CLI takes one. Absent on a turn that carries
   * none, which is every turn a person sends. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  /** The vault's values for the agent's own MCP servers, for this launch alone and as its CLI takes them: whole entries
   * for one that takes servers in a file, config keys for one that takes keys as its thread starts. Absent where the
   * computer's own files hold the values or the turn's environment carries them. */
  serverValues?: { entries?: Readonly<Record<string, Readonly<Record<string, unknown>>>>; config?: Readonly<Record<string, string>> };
  /** On a resume: the thread so far as text, for an adapter whose CLI holds no session under `resume` to open a new one
   * with. Asked for only then. */
  seed?: () => Promise<string>;
  /** On an agent whose plan banks resets: the turn reads each in full, since the account's last full read is missing
   * or a day old. Absent, it reads their count alone, which costs the agent's backend nothing more. */
  limitDetails?: true;
  /** On an adapter that waits for its prompt: its CLI starts at once and is handed the prompt when this settles. */
  promptAfter?: Promise<void>;
  /** The version the agent's binary on this machine answered the catalog probe with; absent where the probe got no
   * answer and wsp's own table stood in. */
  version?: string;
  /** The agent's process stays up once the turn is over, for the thread's next send; kept() hands it over. */
  keep?: true;
  onEvent: (event: AdapterEvent) => void;
}

export interface HarnessSession {
  readonly localId: string;
  readonly finished: Promise<TurnResult>;
  /** What a later host process attaches to this turn by, on a harness whose run outlives the host that started it;
   * absent where it does not, and the row is settled as cut when this process goes. */
  readonly run?: string;
  /** The process this turn leads on the computer the host runs on, where it runs there; absent on a turn running on
   * another machine, whose pids are not this computer's. */
  readonly pid?: number;
  /** Where this turn starts in its run's log, on a process that served the thread's earlier turns: what a later host
   * re-opens the turn from. */
  readonly from?: number;
  /** Stops the turn; finished settles after it, once session.end has been emitted. On a process kept between turns
   * the process stays up where the agent took the stop. */
  interrupt(): Promise<void>;
  /** Once the turn is over, its agent's process still up for the thread's next turn; absent on an adapter that keeps
   * none, and nothing where this turn's process went with it. */
  kept?(): KeptAgent<HarnessSession> | undefined;
  /** Present on a harness that takes a message mid-turn; absent means it cannot. not-running when the turn had not
   * started or had ended when the message was offered. `id` is what a harness that tells unread messages tells this
   * one by. `images` reach only an adapter that declares steersImages. */
  steer?(prompt: string, id?: string, images?: readonly TurnImage[]): Promise<"accepted" | "not-running">;
  /** Whether this turn tells, as it ends, the steered messages its agent never read (`turn.unread`), a turn re-opened
   * after a host restart included: read off what the agent's CLI said it does when it announced itself, so it is
   * false until then. Absent, nothing says whether a steer whose answer never came was read. */
  readonly tellsUnread?: boolean;
  /** Answers a permission prompt this turn raised; absent on a harness that raises none this host can answer. The
   * caller names the outcome, since only it knows whether the answer is the person's or its own for a prompt nobody
   * came to, and the adapter emits the permission.close that carries it. `gone` when no such prompt is open. */
  answer?(askId: string, answer: { optionId: string; outcome: PermissionOutcome; denyMessage: string; reason?: string }): Promise<"answered" | "gone">;
  /** Puts this running turn into another access mode from its next tool call on, and to the prompt it is stopped on
   * where the mode answers one; absent on a harness whose CLI takes no such change once a turn is under way, and the
   * person's pick then waits for their next message. `refused` is the CLI's own no to that mode with no road left to
   * stand in for it, `gone` a turn whose channel takes nothing any more. */
  setAccess?(mode: string): Promise<"set" | "refused" | "gone">;
  /** Stops one of this turn's own subagents by the agent's id for it, the turn and its other subagents running on;
   * absent on a harness that stops none by itself. */
  stopTask?(task: string): Promise<TaskStop>;
}

export interface HarnessAdapter {
  start(options: HarnessStartOptions): HarnessSession;
  /** Re-opens a turn this harness is still running on the machine, by the run handle a session of an earlier host
   * process reported. The run's whole output is read again, so the events the host missed reach this one. `gone` is
   * the machine's own answer that it no longer holds the run, and no event is emitted for one. A machine that
   * answers nothing rejects, and the turn is left where it is. Absent on an adapter whose runs die with the host. */
  attach?(options: AdapterAttachOptions): Promise<HarnessSession | "gone">;
  /** Whether this adapter's sessions carry steer; the catalog tells the composer before a turn runs. */
  readonly steers: boolean;
  /** Whether every file the agent's own tool calls write is named by a tool_use its row reads paths off, so a turn in
   * a folder another thread also worked in can tell its own changes from the rest. Absent, that turn's card lists the
   * folder's changes and says so. */
  readonly reportsEdits?: true;
  /** Whether a rewind of this harness's thread is cut on its next resume, at the anchor the kept turn named; the
   * runtime holds that anchor on the thread and hands it to that start as resumeAt. */
  readonly resumesAt?: true;
  /** Cuts this harness's own history before a turn at once, running no turn; absent where it cuts on its next resume
   * or keeps its history. */
  revert?: SessionReverter;
  /** How this harness takes an image with a turn, and that it takes one at all: absent, a turn carrying an image is
   * refused in this agent's name before the machine is asked for anything. */
  readonly attachments?: AttachmentRoad;
  /** Whether this adapter renders the MCP servers a start names into the launch its CLI takes. Absent means it does
   * not, and a start naming servers is refused in this agent's name before the machine is asked for anything: a
   * launch that dropped them would open a thread whose tools are missing and whose agent looks like it ignored them. */
  readonly mcpServers?: true;
  /** The commands this CLI runs only in its own terminal, which a headless turn answers are not available; the catalog
   * carries them so the composer lists none and sends nothing for one. Absent means none. */
  readonly screenCommands?: ReadonlyArray<ScreenCommand>;
  /** Whether an access picked while a turn runs reaches that turn, so the picker says what a pick does before it is
   * made. Absent means it does not, and a pick waits for the person's next message. */
  readonly movesAccess?: true;
  /** Whether this adapter's steer carries a message's images into the running turn; absent, a message with one waits
   * for the turn to end. */
  readonly steersImages?: true;
  /** A start takes promptAfter, so the launch's snapshot is taken while the CLI starts up and the agent, which touches
   * no file before it has its prompt, gets it once the snapshot is in; absent, the snapshot is in before the launch. */
  readonly waitsForPrompt?: true;
  /** Asks the binary on the workspace's machine what it takes: its lists, its own words for why it has none, or null
   * when it does not answer at all; absent, the table alone answers and nothing runs. */
  probeCatalog?(exec: HarnessExec): Promise<HarnessCatalogAnswer>;
  /** Asks the same binary its version alone, which says whether lists it answered before are still its lists; absent,
   * nothing can say so and lists held from before wait for the probe. */
  probeVersion?(exec: HarnessExec): Promise<string | null>;
  /** Reads the harness's own title for a session out of its store on the machine; absent on a harness that keeps none. */
  sessionTitle?: SessionTitleReader;
  /** Writes a person's name for a session into that same store; absent on a harness that keeps no name of a person's. */
  renameSession?: SessionRenamer;
  /** Asks the harness itself for a name for a thread it has just replied in; absent on a harness that cannot answer a
   * question of its own. */
  titleFor?: SessionTitleMaker;
  /** Asks the harness itself for a commit message with no thread and no tool; absent on a harness that cannot answer
   * a question of its own, and the commit box opens empty with the line saying so. */
  draftFor?: CommitDrafter;
  /** Answers a question beside a thread on a copy of its session that nothing keeps; absent on a harness that cannot
   * copy a session, and the composer offers no side question for it. */
  aside?: SessionAsker;
  /** Whether that copy loads the MCP servers a turn of the thread is handed. Only then is it handed them and the
   * thread's host pair; a copy that loads none would carry a token nothing dials with. */
  readonly asideServers?: true;
  /** The message that runs this harness's own compaction of the thread's context as a turn; absent where it has none. */
  readonly compacts?: string;
  /** The command that opens one of this harness's sessions in the person's own terminal, the session id going after
   * it; absent where the CLI has no such road. */
  readonly terminalResume?: string;
  /** What a turn's command is exported with on the machine; a plain exec on the workspace runs with the same. Absent
   * means nothing is exported and both run with the machine's own environment only. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Called per session start with the workspace's CURRENT machine (it can change on wake/upgrade). */
export type HarnessAdapterFactory = (ctx: HarnessAdapterContext) => HarnessAdapter;
/** What a start names of its agent and picks, read against that agent's lists before a folder is made for it. */
export type StartPicksAsked = { harness?: string; model?: string; effort?: string; access?: AccessChoice; permissionMode?: string; fast?: boolean };
