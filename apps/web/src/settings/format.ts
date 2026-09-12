// SPDX-License-Identifier: AGPL-3.0-only
// The words the settings page and its palette row say, one place, keyed by the
// preference value where a value has words of its own.
import { fmtPx, type TerminalSizeSource, type ThemePreference } from "@wsp/protocol";

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

/** The Where agents run section: its title, its four columns, the words a row's state slot and its detail carry,
 * and the two actions under the table. */
export const WHERE_WORDS = {
  title: "Where agents run",
  computer: "Computer",
  size: "Size",
  diskFree: "Disk free",
  workspaces: "Workspaces",
  more: "More",
  addComputer: "Add a computer",
  connectProvider: "Connect a provider",
  default: "default",
  setDefault: "Set as default",
  rename: "Rename",
  remove: "Remove",
  /** Why a row's action is held: the op that carries it is not on the wire yet. */
  notYet: "not on this wsp yet",
  system: "System",
  joined: "Joined",
  answered: "Answered",
  none: "none",
  agentsOnly: "agents only",
  notAnswering: "not answering",
  removing: "Removing\u2026",
  cancel: "Cancel",
  /** What a row's detail says where nothing on the wire carries that fact yet. */
  unknown: "not known here",
} as const;

/** Add a computer: the sheet's head, its two roads and every line each road says. */
export const ADD_COMPUTER_WORDS = {
  title: "Add a computer",
  app: {
    road: "Runs the wsp app",
    description: "A computer you own runs threads for your wsp. It connects to this Mac over your network. You open nothing on it.",
    sentence: "On that computer, open wsp and press",
    press: "This Mac joins another wsp",
    then: ". Type these.",
    address: "Address",
    code: "Code",
    good: "the code is good for 10 minutes",
    expired: "the code expired; press New code",
    newCode: "New code",
    waiting: "waiting for it to connect",
    connected: "connected \u00b7 keys exchanged",
    noApp: "No app on that computer",
    noAppSentence: "In its terminal, install wsp, then join:",
    install: "npm i -g wsp",
    footNote: "closes, the code stays good",
    /** Where the join address comes from and why it can be the wrong one. */
    loopback: "this address reaches your wsp only from this computer; open wsp at your Mac's network address for one to hand over",
  },
  ssh: {
    road: "Linux box over ssh",
    description: "The app logs in over ssh as your terminal would, installs wsp on the box, and the box connects to this Mac.",
    login: "Login",
    loginPlaceholder: "user@host",
    port: "Port",
    portPlaceholder: "22",
    addon: "ssh",
    note: "Your ssh agent and config are used as they stand. Nothing is asked for a key unless ssh refuses.",
    add: "Add",
    adds: "adds",
    loginFirst: "type the login first",
    /** Why Add is held on a host whose wsp cannot log in over ssh yet. */
    noRoad: "this wsp cannot log in over ssh yet",
    refusedFix: "Check the user and the address, or",
    pickKey: "pick a key file",
    portWord: "port",
    running: "closing keeps it going",
    named: "Named after its hostname. Rename it from its row.",
  },
  close: "Close",
  /** The joined screen: what the computer is now, by whether it can run copies of the image. */
  joinedTitle: (name: string): string => `${name} joined`,
  joined: "joined",
  joinedWithDocker: "It can run copies of your image. Your image is built there the first time a workspace is created on it.",
  joinedWithoutDocker: "It runs your agents as one workspace. Without Docker it cannot run copies of your image.",
  installDocker: "install Docker to run copies of your image",
  optional: "optional",
  open: (name: string): string => `Open ${name}`,
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
  pasteFirst: "paste the key first",
  key: "API key",
  keyTitle: (name: string): string => `Connect ${name}`,
  keyDescription: (name: string): string => `Paste an API key from your ${name} account. It is checked with ${name} before it is saved.`,
  where: (name: string): string => `Get one at ${name}`,
  refused: (name: string, said: string): string => `${name} refused this key (${said}).`,
  refusedFix: (name: string): string => `Paste one from your ${name} account, or make a new one there.`,
  unreached: (name: string): string => `${name} could not be reached to check the key.`,
  unreachedFix: "Check the network and try again.",
  /** Why Save is held on a provider whose key has no road on the wire yet. */
  noRoad: (name: string): string => `this wsp cannot save a ${name} key yet`,
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
