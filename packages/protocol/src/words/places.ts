// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentSignInState, ContextMenuItem, HostsView, PlaceView, ProjectExportEvent, ProjectImportEvent, ProjectSecret, TerminalConfig, TerminalRgb, WorkspaceGlyph } from "../index.js";
import { dotColour, effectiveOpacity, themeInk, type Rgb, type WorkspaceTheme } from "../workspace-look.js";
import { compareVersions } from "../semver.mjs";
import { plural } from "./base.js";
import { fmtBytes, fmtCost, fmtDuration, fmtRate } from "./units.js";
/** The line under the import dialog's title: which workspace, and that the folder lands at the path it has here. */
export function importIntoLine(workspaceName: string): string {
  return `Into ${workspaceName}, at the same path.`;
}

/** The repository row of a plan, in words a stranger reads: the history travels with a .git, or there is none. */
export function repoLine(repo: boolean): string {
  return repo ? "Git repository, history travels" : "No repository";
}

/** What the ticks on the secret-shaped rows do, under how many rows there are. */
export function secretsNote(n: number): string {
  return `${plural(n, "file")} ${n === 1 ? "looks like a secret" : "look like secrets"}. Ticked files are copied as they are. Unticked files are left out and listed.`;
}

/** What the ticks on the agent rows do. */
export const SESSIONS_NOTE = "Ticked agents' sessions go with the folder. The rest stay here.";

/** Why a secret-shaped file was flagged and its size, as the CLI's plan column and the dialog's hover both print it. */
export function secretSignalsLine(s: ProjectSecret): string {
  return `${s.signals.join(", ")}, ${fmtBytes(s.bytes)}`;
}

/** The line under the export dialog's title: which workspace the folder leaves, and the computer it lands on. */
export function exportFromLine(workspaceName: string, here: string): string {
  return `From ${workspaceName}, to ${here}.`;
}

/** What the ticks on the export dialog's agent rows do. */
export const EXPORT_SESSIONS_NOTE = "Ticked agents' sessions come home with the folder. The rest stay in the task.";

/** The export dialog's agent section when the workspace has no threads to make rows of. */
export const NO_THREADS_NOTE = "No threads here. Every agent's sessions for the folder come home with it.";

/** What a row of the export's summary says before the folder has landed, since nothing is read from the machine first. */
export const NOT_LANDED_WORD = "when it lands";

/** A trip's events folded into the one progress line and its bar. */
export interface TripProgress {
  readonly line: string;
  /** How far the bar is, 0 to 1; it never goes back. */
  readonly fraction: number;
}

/** An import's events folded into the one progress line and its bar. The words are the last event's step: the two
 * steps before packing pass in a blink and read as starting, packing keeps the runtime's count, an upload is named
 * by its total so the words hold still while the bar moves, a landing by the workspace it lands on. The runtime lands
 * the project and then uploads and lands the sessions tar in a second pass, so that pass is named and the bar holds
 * its high-water mark instead of dropping to nought. A failure has no step; the status line carries it. */
export function importProgress(events: readonly Pick<ProjectImportEvent, "stage" | "message" | "bytes" | "total">[], workspaceName: string): TripProgress | null {
  let line = "";
  let fraction = 0;
  let landings = 0;
  for (const e of events) {
    switch (e.stage) {
      case "planned":
      case "consented":
        line = "Starting";
        break;
      case "packing":
        line = e.message.replace(/\.$/, "");
        break;
      case "uploading": {
        const what = landings > 0 ? " sessions" : "";
        const size = e.total === undefined ? "" : `${what === "" ? "" : ","} ${fmtBytes(e.total)}`;
        line = `Uploading${what}${size}`;
        if (e.bytes !== undefined && e.total !== undefined && e.total > 0) fraction = Math.max(fraction, e.bytes / e.total);
        break;
      }
      case "landing":
        landings += 1;
        line = `Landing on ${workspaceName}`;
        fraction = 1;
        break;
      case "done":
        line = "Done";
        fraction = 1;
        break;
      case "failed":
        return null;
    }
  }
  return events.length === 0 ? null : { line, fraction };
}

/** An export's events folded into the one progress line and its bar. The runtime packs and downloads the folder,
 * then packs and downloads the sessions as a second pass whose bytes start again at nought, so the pass is named by
 * counting the packings and the bar holds its high-water mark; a download is named by its total so the words hold
 * still while the bar moves. A failure has no step; the status line carries it. */
export function exportProgress(events: readonly Pick<ProjectExportEvent, "stage" | "bytes" | "total">[], here: string): TripProgress | null {
  let line = "";
  let fraction = 0;
  let packings = 0;
  const pass = (): string => (packings > 1 ? "sessions" : "the folder");
  for (const e of events) {
    switch (e.stage) {
      case "packing":
        packings += 1;
        line = `Packing ${pass()}`;
        break;
      case "downloading":
        line = `Downloading ${pass()}${e.total === undefined ? "" : `, ${fmtBytes(e.total)}`}`;
        if (e.bytes !== undefined && e.total !== undefined && e.total > 0) fraction = Math.max(fraction, e.bytes / e.total);
        break;
      case "landing":
        line = here === "" ? "Landing" : `Landing on ${here}`;
        fraction = 1;
        break;
      case "done":
        line = "Done";
        fraction = 1;
        break;
      case "failed":
        return null;
    }
  }
  return events.length === 0 ? null : { line, fraction };
}

/** A color as a Ghostty file writes it. */
export function hexColor({ r, g, b }: TerminalRgb): string {
  return `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

export const NO_TERMINAL_CONFIG_LINE = "No Ghostty config on this computer; the terminal pane keeps its defaults.";

/** The person's terminal config as wsp terminal config prints it: the files read, then each key the pane honours as
 * the file would write it, so a line here can be pasted back into the config. */
export function terminalConfigLines(config: TerminalConfig): string[] {
  if (config.files.length === 0) return [NO_TERMINAL_CONFIG_LINE];
  const set = config.palette.filter(c => c !== null).length;
  const pair = (a: number, b: number): string => (a === b ? `${a}` : `${a},${b}`);
  const rows: [string, string | undefined][] = [
    ["font-family", config.fontFamily.length === 0 ? undefined : config.fontFamily.join(", ")],
    ["font-size", config.fontSize?.toString()],
    ["theme", config.theme],
    ["background", config.background && hexColor(config.background)],
    ["foreground", config.foreground && hexColor(config.foreground)],
    ["palette", set === 0 ? undefined : `${set} of 16 colors`],
    ["selection-background", config.selectionBackground && hexColor(config.selectionBackground)],
    ["cursor-color", config.cursorColor && hexColor(config.cursorColor)],
    ["cursor-style", config.cursorStyle],
    ["cursor-style-blink", config.cursorStyleBlink?.toString()],
    ["window-padding-x", config.windowPaddingX && pair(config.windowPaddingX.left, config.windowPaddingX.right)],
    ["window-padding-y", config.windowPaddingY && pair(config.windowPaddingY.top, config.windowPaddingY.bottom)],
    ["background-opacity", config.backgroundOpacity?.toString()],
    ["background-blur", config.backgroundBlur?.toString()],
  ];
  return [`Read ${config.files.join(", ")}`, ...rows.filter(([, value]) => value !== undefined).map(([key, value]) => `${key} = ${value}`)];
}

/** A glyph's id as a picker names it. The ids are one word each, so the word is the id with its first letter up; a
 * second table of names would drift from the list the wire validates against. */
export function lookWord(id: WorkspaceGlyph): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The custom properties a workspace's theme paints with, the one place the theme object is read. The gradient is
 * one dot's colour laid flat, two dots fading toward each other from opposite corners, or three with two settling
 * in the top corners over the third rising from the bottom; every stop carries the opacity as its alpha, so the
 * colour lies over whatever surface the sidebar has, the glass, the macOS material or the plain token, rather
 * than replacing it, held under the cap that keeps the side's words reading. The grain is the slider's number,
 * which the stylesheet gives to a pre-rendered tile. The ink is the one colour the chrome takes from the theme. */
export interface ThemeVars {
  readonly "--space-gradient": string;
  readonly "--space-grain": string;
  readonly "--space-tint": string;
}

/** A share as a whole percent: 0.5 reads 50%. */
export function fmtPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** What the app says about a desktop shell and the host that served it its page being of two releases. */
export interface ShellVersionNotice {
  /** The one line the app shows. */
  line: string;
  /** True while the person is being pointed at a newer app; the line asks for the app's own host instead when the
   * shell is the newer half, since there is nothing to download for that. */
  update: boolean;
}

/** The word on the notice's one button, which opens the releases page away from the app's window. */
export const GET_THE_APP_WORD = "Get";

/** The line for a desktop shell whose page came from a host of another release, and nothing while the two agree.
 * The halves ship together and every call over the bridge needs both, so the older one is named with what to do
 * about it. A shell whose bridge carries no version at all is one from before the bridge carried one, which is
 * older than any host that reads this. */
export function shellVersionNotice(shell: string | undefined, host: string, label?: string): ShellVersionNotice | undefined {
  const named = label === undefined ? "the host" : `the host ${label}`;
  if (shell === undefined) return { line: `this app is older than ${named}, which is ${host}: get the new app`, update: true };
  const order = compareVersions(shell, host);
  if (order === 0) return undefined;
  const both = `this app is ${shell}, ${named} is ${host}`;
  return order < 0 ? { line: `${both}: get the new app`, update: true } : { line: `${both}: run the app's own host`, update: false };
}

/** The words of the desktop's hosts: the menu and the sidebar's foot read them here. */
export const HOST_WORDS = {
  hosts: "Hosts",
} as const;

/** How long a computer has been away, coarse on purpose: the figure is read once in a table, not watched. */
export function offlineFor(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** The Workspaces cell of that table: how many stand on the computer, what it has cost this month where somebody
 * is charging for them, and the one thing about the computer that changes what a person may put there. Whether it
 * is answering is not one of them: the state slot beside its name carries that, and a row that said it twice was a
 * row that said it in two wordings. The count is what the caller reads off the workspace list, never off the row:
 * a row carries at most the one workspace its join recorded, so this computer's own workspace and a provider's
 * forks are on neither. */
export function placeWorkspacesCell(view: PlaceView, count: number, monthUsd?: number): string {
  const { count: n, note } = placeWorkspacesParts(view, count, monthUsd);
  return note === undefined ? n : `${n}, ${note}`;
}

/** The same cell in its two parts, for a table that draws them in two inks: the count a person is counting, and
 * the note behind it, which is the mock's muted clause. A line that is one string (the command line's row, a
 * title) reads placeWorkspacesCell instead; both are this one rule. */
export function placeWorkspacesParts(view: PlaceView, count: number, monthUsd?: number): { count: string; note?: string } {
  const n = `${count}`;
  // A copy being built or stopped there is what the row has to say while it lasts: the workspaces the row counts wait on it.
  if (view.build !== undefined) return { count: n, note: view.build };
  // Only a provider bills: a computer of the person's own runs their workspaces for nothing, whatever it runs them on.
  if (view.kind === "provider") return monthUsd === undefined ? { count: n } : { count: n, note: spentThisMonth(monthUsd) };
  return { count: n };
}

/** What a place has taken since the first of the month, the clause every surface that says it says. */
export const spentThisMonth = (usd: number): string => `${fmtCost(usd)} this month`;

/** What a cloud has spent today over its spend per day, the SPEND cell and the meter's figure: the limit is a number
 * the person typed, so it reads as typed, in whole dollars where it has no cents. */
export function spendMeterWord(todayUsd: number, capUsd: number): string {
  return `${fmtCost(todayUsd)}/${Number.isInteger(capUsd) ? `$${capUsd}` : fmtCost(capUsd)}`;
}

/** The Spend row of a place's detail: the month behind it, what it burns right now and how many workspaces that is
 * across. A row burning nothing says so with the rate rather than dropping the clause, since a $0.00/hr that is
 * measured and a figure left out read differently. */
export function placeSpendLine(spend: { monthUsd: number; rateUsdPerHour: number }, workspaces: number): string {
  return `${spentThisMonth(spend.monthUsd)}, ${fmtRate(spend.rateUsdPerHour)} now across ${plural(workspaces, "workspace")}`;
}

/** The foot under the places table: what the providers that have taken something this month took, together, and how
 * many of them that is. A provider that took nothing is not in the count, whether nothing was ever metered on it or
 * its workspaces have all been asleep since last month: a count of two where one charged reads as two bills. */
export function placesSpendFoot(monthUsd: number, providers: number): string {
  return `${spentThisMonth(monthUsd)} across ${plural(providers, "provider")}`;
}

/** The doctor's word on the engine a project's own containers run on here: the engine when the box has one, else
 * the line that says installing one opens it. A place that has not yet said reads nothing. */
export function placeEngineLine(view: Pick<PlaceView, "name" | "engine">): string | undefined {
  if (view.engine === undefined) return undefined;
  if (view.engine === "none") return `${view.name} has no container engine; a project's docker compose runs there once you install Docker or podman on it`;
  return `${view.name} runs a project's own containers on ${view.engine}; a workspace made with --engine gets a socket to it and sees its own containers alone`;
}

/** What a person reads for whether an agent on a computer can take a turn there as things stand: its own login on
 * that computer, the key of theirs wsp hands it, or nothing yet. One home for the three words, so the table, the
 * doctor and the agents block under a computer's row cannot word them three ways. */
export function agentSignInWord(state: AgentSignInState): string {
  return state === "signed-in" ? "signed in" : state === "vault-key" ? "your key" : "not signed in";
}

/** The version number in what an agent's own version flag printed: agents word that line their own way (`2.1.270
 * (Claude Code)`, `codex-cli 0.153.0`), so the number is lifted out where there is one and the line stands as the
 * computer said it where there is not. */
export function agentVersionWord(raw: string): string {
  return /\d+\.\d+\.\d+/.exec(raw)?.[0] ?? raw.trim();
}

/** semver.org's own pattern, whole. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const VERSION_MAX_CHARS = 64;

/** A version read off the network or a tag: the whole trimmed text, one leading v aside, is a strict semver under the
 * cap, or it is nothing. No number is ever lifted out of other words, since an error page can carry one. */
export function strictVersion(raw: string): string | undefined {
  const bare = raw.trim().replace(/^v/, "");
  return bare.length <= VERSION_MAX_CHARS && SEMVER.test(bare) ? bare : undefined;
}

/** The agents cell of the computers table: each agent that computer reported, its version and the word for its
 * sign-in, one clause apiece. Empty where the row reported no agent at all, which is a cloud account, this
 * computer, and a computer that has not said yet. */
export function agentsCell(place: Pick<PlaceView, "agents" | "agentVersions" | "signIns">): string {
  return (place.agents ?? [])
    .map(id => {
      const version = place.agentVersions?.[id];
      const state = place.signIns?.[id];
      return [id, version === undefined ? undefined : agentVersionWord(version), state === undefined ? undefined : agentSignInWord(state)].filter(word => word !== undefined).join(" ");
    })
    .join(", ");
}

/** How much of the provider's own reason for refusing a key a sentence carries: enough to tell a dead key from a
 * narrowed one, short enough to stay one sentence. */
const REFUSAL_REASON_MAX = 80;

/** The one line a codex turn fails with when it ran on the person's own key and the provider turned that key down:
 * whose key was refused, what the provider said about it, and the two ways out. Never the not-signed-in line,
 * which would send a person to sign in when what they have is a key that no longer works. `reason` is what the CLI
 * printed after the status, empty when it printed nothing, and a refusal with nothing after it drops the clause
 * rather than reading as a colon with nothing behind it; `login` is the catalog's sign-in command for a machine. */
export function codexKeyRefusedLine(keyEnv: string, reason: string, login: string): string {
  const said = reason.trim().slice(0, REFUSAL_REASON_MAX).trim();
  return `OpenAI refused your ${keyEnv}${said === "" ? "" : `: ${said}`}. Put a working key in ~/.wsp/.env, or sign Codex in where this thread runs with ${login}.`;
}

/** The verb alone, for the host road that runs that leave on another computer over the line that computer said
 * starts its own wsp: two spellings of the word would have those two agreeing by luck. */
export const PLACE_LEAVE_VERB = "leave";

/** The one line that takes wsp off a computer it is typed on. */
export const PLACE_LEAVE_LINE = `wsp ${PLACE_LEAVE_VERB}`;

/** The copy of the image on a computer of the person's own, in the words every screen that mentions it says. It sits in
 * the runtime's folder there, which a leave run as root takes whole, so it comes off with wsp: the dialog that removes
 * a computer and the line that dialog hands over both say so. The size is the copy's where the host knows it; a
 * screen that does not know it names the copy without a figure rather than one it is guessing. */
export const imageCopyLine = (size?: string): string => `the copy of your image${size === undefined ? "" : ` (${size})`}`;

/** Everything wsp puts on a computer it is installed on, named once. The Add sheet writes its lines and the note
 * under them from this list and the Remove dialog writes its sentence from the same, so what a person is told
 * before they press Add is what they are told on the way out. Nothing here is called a shim: a person reads what
 * the thing does, since nobody outside this repo knows what a shim is.
 *
 * The paths behind the words are placeOwnedPaths', which is the list a sweep actually walks. */
export const PLACE_INSTALL = {
  /** Where wsp's own files land under that login's home, and what they weigh there. */
  folder: "~/.wsp",
  weight: "about 40 MB",
  /** What holds the daemon up: a unit under /etc/systemd/system, which needs root and starts again at every boot. */
  service: "a system service",
  /** The three things a sweep takes off again, in the order placeOwnedPaths walks them and in the grammar Remove
   * says them: the unit that holds the agent up, the files under wsp's own folder, and the command beside them.
   * The Add lines name the same three in their own grammar, so a fourth thing landing on a box cannot show on one
   * screen and not the other. */
  taken: {
    service: "the daemon's service",
    files: "wsp's own files under that login's home",
    opener: "the command beside them that opens sign-in pages in your browser",
  },
  /** What that command does, as its own sentence for a screen that lists what lands rather than what comes off. */
  openerLine: "Sign-in pages started on that computer open in your browser here.",
} as const;

/** The words of the Settings section for where a person's agents run, and of the sheet that adds a computer. */
export const PLACES_WORDS = {
  section: "Computers",
  columns: ["Computer", "Size", "Disk free", "Workspaces"],
  addComputer: "Add a computer",
  connectProvider: "Connect a provider",
  sheet: {
    install: "npm i -g @wsp-labs/wsp",
    /** The line typed in a terminal on the computer being joined. The token is the code and the fingerprint of the
     * key this host will prove, as joinToken writes them, so the line names which host it is joining. */
    joinLine: (url: string, token: string): string => `wsp join ${url} --code ${token}`,
    relayNote: "when the host is linked to your relay",
    /** Said once, the first time the door binds: a Mac with its firewall on asks whether wsp may accept connections. */
    firewall: "macOS may ask once whether wsp can accept connections; allow it",
  },
  remove: {
    /** The line run on the computer itself, which is the one road that also takes the agent's service: the sweep
     * the host asks for over the link leaves the unit standing, since its name is the host's rule and not the
     * agent's. */
    leaveLine: PLACE_LEAVE_LINE,
    /** What that line takes and what it leaves, off the one list a sweep reads (placeOwnedPaths), which names the
     * files under wsp's folder and never the folder itself, and the unit the manager holds the agent up with. Run as
     * root on a computer added over ssh it takes the runtime's folder too, the copy of the image in it; one joined
     * with a code has no record of what stood before, and keeps it. What it leaves is the work folder. */
    leaveTakes: `It takes off ${PLACE_INSTALL.taken.service}, ${PLACE_INSTALL.taken.files}, ${PLACE_INSTALL.taken.opener}, and, on a computer added over ssh, ${imageCopyLine()}. Your work folder stays.`,
  },
} as const;

/** Every line a computer you own can join this host by: one per address it answers on, and the relay's address
 * last, with the note that it only answers while the host is linked. The one list wsp add prints and the app draws. */
export function joinRoads(token: string, urls: readonly string[], relayUrl: string | undefined): { url: string; line: string; note?: string }[] {
  const road = (url: string, note?: string): { url: string; line: string; note?: string } => ({ url, line: PLACES_WORDS.sheet.joinLine(url, token), ...(note === undefined ? {} : { note }) });
  return [...urls.map(url => road(url)), ...(relayUrl === undefined ? [] : [road(relayUrl, PLACES_WORDS.sheet.relayNote)])];
}

/** What the app calls the computer it runs on, first in every hosts list. */
export const hereWord = (mac: boolean): string => (mac ? "This Mac" : "This computer");

const HOST_MENU_SWITCH = "switch:";

/** The Hosts menu as one list of rows, read by the shell's own menu bar and by the sidebar's foot alike: this computer
 * first, then every host on the account, the current one marked. */
export function hostsMenuItems(view: HostsView): ContextMenuItem[] {
  return [
    { id: HOST_MENU_SWITCH, label: view.here, group: "hosts", enabled: true, checked: view.current === null },
    ...view.hosts.map((h): ContextMenuItem => ({ id: `${HOST_MENU_SWITCH}${h.alias}`, label: h.alias, group: "hosts", enabled: true, checked: h.alias === view.current })),
  ];
}

/** The host a row of the Hosts menu moves the window to, null for this computer, read back off its id; nothing for an
 * id the list above never minted. */
export function hostMenuAction(id: string): { alias: string | null } | undefined {
  if (!id.startsWith(HOST_MENU_SWITCH)) return undefined;
  const alias = id.slice(HOST_MENU_SWITCH.length);
  return { alias: alias === "" ? null : alias };
}

/** How often a linked host says where it is on its account, and so how fresh a listing of the account's hosts can
 * be. Read by the host that beats and by the table below that calls a host up or away, so the two cannot drift. */
export const HOST_BEAT_MS = 60_000;

/** One row of the one listing wsp hosts prints: a host on the person's account. The command line builds the rows off
 * the relay's listing and the records under its hosts folder; the words are here, beside every other table's. */
export interface HostsTableRow {
  host: string;
  /** Where it answers, and nothing for a host on the account that has not said where it is yet. */
  address?: string;
  /** How long since its last beat, null for a host that has never beaten, and nothing for a row read off this
   * computer's own records while the relay did not answer. */
  awayMs?: number | null;
  /** The device this computer holds there, which the account road has none of until its first dial. */
  deviceId?: string;
  connector?: string;
  /** The fingerprint of the key it proves, which every dial holds it to and a person compares with the one wsp
   * host pair prints over there. */
  hostKey?: string;
  default?: boolean;
}

/** What a host on the account with no address reads as: there is nothing to dial until wsp up runs over there. */
export const NOT_UP_YET = "not up yet";

/** What a host that is beating with no address reads as: it is up, and it says where it is only from a wsp new
 * enough to send the key every dial holds it to, so its address lands at its next start. One row says one thing:
 * a host the state column calls up is never called not up yet beside it. */
export const ADDRESS_NEXT_START = "waits on its next start";

/** Whether a host on the account is answering, off the time since its last beat: up while it is inside two beats,
 * since one missed beat is a slow minute rather than a host that is gone, and away with the time since after that.
 * A host that has never beaten has never been up. */
export function hostBeatWord(awayMs: number | null): string {
  if (awayMs === null) return "not yet";
  if (awayMs <= 2 * HOST_BEAT_MS) return `up ${fmtDuration(Math.max(0, awayMs))}`;
  return `away ${offlineFor(awayMs)}`;
}

/** The cells of the one hosts table, the header first: every host on the account this computer can reach. */
export function hostsTable(rows: readonly HostsTableRow[]): string[][] {
  return [
    ["HOST", "ADDRESS", "STATE", "DEVICE", "CONNECTOR", "KEY", ""],
    ...rows.map(row => [
      row.host,
      row.address ?? (row.awayMs === undefined || row.awayMs === null ? NOT_UP_YET : ADDRESS_NEXT_START),
      row.awayMs === undefined ? "" : hostBeatWord(row.awayMs),
      row.deviceId ?? "",
      row.connector ?? "",
      row.hostKey ?? "",
      row.default === true ? "default" : "",
    ]),
  ];
}

/** What wsp hosts prints for a person who can reach nothing: the road to a host on the account. */
export const NO_HOSTS_LINE = "You can reach no host but this computer. Run wsp login to sign in to your account.";

/** What wsp hosts prints when the relay did not answer: what this computer holds is still the truth about what it
 * can dial, so the rows are printed and the relay's own words go above them. */
export const relayQuietLine = (why: string): string => `${why}; the rows below are the hosts this computer already holds`;

/** What wsp hosts says about a record it wrote for a host on the account that the account no longer names: the
 * record goes, since a name aimed at it would dial a host nobody on the account holds. */
export const hostDroppedLine = (alias: string): string => `${alias} is no longer a host on your account, so this computer no longer holds a record for it`;

/** What a listing that names another key for a host this computer already pinned is refused with: the key is
 * pinned at first sight and held to on every dial, so a second key is either another host or a relay steering this
 * computer at one. The record keeps the key it pinned. */
export const hostKeyMovedLine = (alias: string, held: string, listed: string): string =>
  `your account lists ${alias} under the key ${listed}, and this computer pinned ${held} when it first saw it; nothing was sent to it. Compare the key wsp host pair prints on that host, and if it is the one the account lists, wsp logout, wsp login and wsp hosts take the account's keys afresh`;

/** A colour as CSS spells it, with its alpha as a percent where one is given. */
export function fmtRgb(colour: Rgb, alpha?: number): string {
  const channels = `${colour[0]} ${colour[1]} ${colour[2]}`;
  return alpha === undefined ? `rgb(${channels})` : `rgb(${channels} / ${fmtPercent(alpha)})`;
}

export function fmtThemeVars(theme: WorkspaceTheme, appDark: boolean): ThemeVars {
  const alpha = effectiveOpacity(theme, appDark);
  const colours = theme.dots.map(dot => fmtRgb(dotColour(dot), alpha));
  const [first, second, third] = colours;
  const gradient =
    colours.length === 1
      ? `linear-gradient(${first}, ${first})`
      : colours.length === 2
        ? `linear-gradient(160deg, ${second} 0%, transparent 100%), linear-gradient(340deg, ${first} 0%, transparent 100%)`
        : `radial-gradient(circle at 0% 0%, ${first} 0%, transparent 70%), radial-gradient(circle at 100% 0%, ${second} 0%, transparent 70%), linear-gradient(to top, ${third} 0%, transparent 65%)`;
  return { "--space-gradient": gradient, "--space-grain": String(theme.grain), "--space-tint": fmtRgb(themeInk(theme, appDark)) };
}

/** What a system notification says when a thread's turn finished while nobody was looking: the page's own line and
 * the desktop's when its window is closed are this one. */
export const threadFinishedLine = (title: string): string => `${title} finished`;

/** The same for a turn that failed; the line under it is the error, in one line. */
export const threadStoppedLine = (title: string): string => `${title} stopped`;

/** What a thread's end says of a process that went without an error of its own: its exit code, when it had one. */
export const exitLine = (exitCode: number | null): string | undefined => (exitCode === null ? undefined : `exit ${exitCode}`);
