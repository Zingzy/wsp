// SPDX-License-Identifier: AGPL-3.0-only
// The words the settings page and its palette row say, one place, keyed by the
// preference value where a value has words of its own.
import { CLOUD_SETUP_WORDS, fmtPx, type TerminalSizeSource, type ThemePreference } from "@wsp/protocol";

/** The caps mono label over a section, and the muted mono a fact wears in a row's slot. Two class strings the page,
 * the table and the sheet all draw with, so one type ladder holds across the three files. */
export const ZONE_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
export const FACT = "font-mono text-[11px] tabular-nums text-muted-foreground";

export const SETTINGS_WORDS = {
  title: "Settings",
  hint: "Theme, sidebar and terminal",
  appearance: "Appearance",
  theme: "Theme",
  sidebar: "Sidebar",
  sidebarWidth: "Sidebar width",
  reset: "Reset",
  terminal: "Terminal",
  textSize: "Text size",
  about: "About",
  version: "Version",
} as const;

/** What the Where agents run section says beyond the words the wire already carries in PLACES_WORDS: the row's
 * detail, its menu and the Remove dialog, which are this build's and are drawn nowhere else. No word is in both. */
export const WHERE_WORDS = {
  more: "More",
  default: "default",
  setDefault: "Set as default",
  rename: "Rename",
  remove: "Remove",
  removing: "Removing\u2026",
  cancel: "Cancel",
  /** Why a row's action is held: the op that carries it is not on the wire yet. */
  notYet: "not on this wsp yet",
  system: "System",
  spend: "Spend",
  agents: "Agents",
  joined: "Joined",
  answered: "Answered",
  none: "none",
  ago: (span: string): string => `${span} ago`,
} as const;

/** What Add a computer says beyond PLACES_WORDS.sheet: the two roads, every line the ssh road says, and the one
 * description the sheet has that the wire's table does not, for a computer that can run copies of the image. */
export const ADD_COMPUTER_WORDS = {
  cancel: "Cancel",
  app: {
    road: "Runs the wsp app",
    /** The words beside the esc keycap; PLACES_WORDS.sheet.escStays carries the keycap in its own string. */
    escCloses: "closes, the code stays good",
  },
  ssh: {
    road: "Linux box over ssh",
    description: "The app logs in over ssh as your terminal would, installs wsp on the box, and the box connects to this Mac.",
    login: "Login",
    loginPlaceholder: "user@host",
    port: "Port",
    portWord: "port",
    portPlaceholder: "22",
    addon: "ssh",
    note: "Your ssh agent and config are used as they stand. Nothing is asked for a key unless ssh refuses.",
    /** The folder the install makes on the box, in that line's fact slot, since the step's own words leave it out. */
    folder: "~/.wsp",
    add: "Add",
    adds: "adds",
    loginFirst: "type the login first",
    /** Why Add is held on a wsp whose host cannot log in over ssh yet. */
    noRoad: "this wsp cannot log in over ssh yet",
    /** What to do about a login ssh would not take, short enough that what ssh said and this together stand on the
     * slot's two lines: a third line moves the note under them. There is no file picker on this road: the host
     * reads the ssh agent and config as they stand, so the key a box wants is named where every other ssh client
     * reads it. */
    refusedFix: "Check the user and the address, or name a key in your ssh config.",
    running: "closing keeps it going",
    named: "Named after its hostname. Rename it from its row.",
  },
  runsWorkspaces: "It runs your workspaces. Your image is built there the first time a workspace is created on it.",
} as const;

/** Connect a provider: the pick, the key and what the provider said. */
export const CONNECT_PROVIDER_WORDS = {
  title: "Connect a provider",
  description: "A provider runs workspaces from your image on its computers and bills by the hour while they run. ASCII starts with a free trial.",
  prices: "Prices are read from the provider for a 2 vCPU, 4 GB workspace. Your key stays on this Mac.",
  cancel: "Cancel",
  continueWord: "Continue",
  back: "Back",
  save: "Save",
  saves: "saves",
  tryAgain: "Try again",
  /** What the keycap says while the provider is being asked about the key: the one loud button on the sheet keeps
   * its variant and says what it is doing, since a press that answers in its own time is not a held one. */
  checking: (name: string): string => `Checking with ${name}`,
  /** Why the keycap is held, which stands in the field's own slot until a key is typed. */
  pasteFirst: "paste the key first",
  key: "API key",
  keyTitle: (name: string): string => `Connect ${name}`,
  keyDescription: (name: string): string => `Paste an API key from your ${name} account. It is checked with ${name} before it is saved.`,
  where: (name: string): string => `Get one at ${name}`,
  refused: (name: string, said: string): string => `${name} refused this key (${said}).`,
  refusedFix: (name: string): string => `Paste one from your ${name} account, or make a new one there.`,
  unreached: (name: string): string => `${name} could not be reached to check the key.`,
  unreachedFix: "Check the network and try again.",
  /** The already connected state, opened again on a provider whose key this computer holds. */
  savedWord: "saved",
  change: "Change",
  dots: "\u2022".repeat(12),
  sizes: { size: "Size", memory: "Memory", rate: "Rate" },
  connectedTitle: (name: string): string => `${name} connected`,
  connectedDescription: (name: string): string => `Workspaces can be created on ${name}. Your image is built there the first time, about three minutes.`,
  savedHere: "saved on this Mac \u00b7 never sent anywhere else",
  accepted: "key accepted",
  newWorkspace: (name: string): string => `New workspace on ${name}`,
  close: "Close",
} as const;

/** Both halves on the about row: the shell holding the page and the host that served it, which are one release run
 * together and two run apart. A browser tab has no shell of its own, so it shows the host's alone; a shell from
 * before the bridge carried a version has one this page cannot name. */
export function versionFact(app: string | undefined, host: string | undefined, inShell: boolean): string {
  const hostPart = `host ${host ?? "unknown"}`;
  return inShell ? `app ${app ?? "unknown"} · ${hostPart}` : hostPart;
}

/** Each theme as its segment names it. */
export const THEME_WORDS: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };

/** Each size source as its segment names it. */
export const TERMINAL_SIZE_WORDS: Record<TerminalSizeSource, string> = {
  app: "From the app",
  file: "From the Ghostty file",
};

/** The size the picked source hands the pane, as the fact beside the control: the app's own size, or the file's,
 * which is the app's again for a file that names none. */
export const TERMINAL_SIZE_FACT: Record<TerminalSizeSource, (appPx: number, filePx: number | undefined) => string> = {
  app: appPx => fmtPx(appPx),
  file: (appPx, filePx) => fmtPx(filePx ?? appPx),
};

/** Settings > Account: the one row that says who this wsp is signed in to, the one sentence that says what a
 * sign-in buys, and the devices row that stands under it once there is one. Nothing about the account is said
 * anywhere else in the window. */
export const ACCOUNT_WORDS = {
  title: "Account",
  github: "GitHub",
  notSignedIn: "not signed in",
  /** The fact for a sign-in the relay named no account for, where signed in is all this computer knows. */
  signedIn: "signed in",
  signIn: "Sign in with GitHub",
  signOut: "Sign out",
  reach: "Sign in to reach this wsp from another device outside your network.",
  devices: "Devices",
  /** The devices fact for an account nothing has paired with this wsp yet. */
  noDevices: "none",
} as const;

/** Settings > Agents: one row per agent this computer has, saying whether its config names the wsp tools, and the
 * one row that stands in its place when it has none. */
export const AGENTS_WORDS = {
  title: "Agents",
  /** An agent whose own config already names the wsp tools. */
  added: "wsp tools added",
  add: "Add the wsp tools",
  /** An agent wsp cannot hand the tools to at launch: its state, and no action beside it. The picker on the init
   * screens says the same of the same agent, so the word has one home. */
  noTools: CLOUD_SETUP_WORDS.choice.noTools,
  none: "No agents found on this Mac.",
} as const;
