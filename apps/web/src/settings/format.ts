// SPDX-License-Identifier: AGPL-3.0-only
// The words the settings page and its palette row say, one place, keyed by the
// preference value where a value has words of its own.
import { CLOUD_SETUP_WORDS, fmtPx, type PlaceDialRoad, type PlaceProvisionRow, type TerminalSizeSource } from "@wsp/protocol";

/** The caps mono label over a section, and the muted mono a fact wears in a row's slot. Two class strings the page,
 * the table and the sheet all draw with, so one type ladder holds across the three files. */
export const ZONE_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
export const FACT = "font-mono text-[11px] tabular-nums text-muted-foreground";

/** A fact's slot where its words may take two lines: exactly two of the line's own line heights, held whether the
 * words take one line or two, and cut at the second with the whole on the element's hover text. The height is read
 * off the line itself (2lh) rather than written as a figure, so a slot and the text in it cannot disagree by the
 * half pixel that moved the first run's button between one line and two. */
export const TWO_LINE_SLOT = "min-h-[2lh] line-clamp-2";

export const SETTINGS_WORDS = {
  title: "Settings",
  hint: "Computers, agents and the terminal",
  appearance: "Appearance",
  sidebarWidth: "Sidebar width",
  reset: "Reset",
  terminal: "Terminal",
  textSize: "Text size",
  about: "About",
  version: "Version",
} as const;

/** What the Computers section says beyond the words the wire already carries in PLACES_WORDS: the row's detail,
 * its agents block, its menu and the Remove dialog, which are this build's and are drawn nowhere else. No word is
 * in both. */
export const WHERE_WORDS = {
  more: "More",
  /** How a workspace's copy of a project is made on that computer, and the sentence for one that makes none. */
  copies: "Copies",
  copiesNothing: "copies nothing",
  /** What a copy there has for a network, in the protocol's own words off the flags the landing carries. */
  ports: "Ports",
  /** Puts this wsp's daemon on that computer and runs the recipe there again. */
  update: "Update",
  updating: "Updating\u2026",
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
  /** The row that says where the host expects that computer: the login it dials, or the address the computer
   * dialled in from, with the road it is. */
  address: "Address",
  none: "none",
  ago: (span: string): string => `${span} ago`,
  /** The button beside that reading, which asks the host to dial the computer once, worded by the road that dial
   * would take: a frame on the link the computer is holding, or the ssh login it was installed over. A computer
   * that joined by typing a code and is not answering has neither, and gets no button at all. */
  dial: { link: "Try now", ssh: "Try over ssh" } satisfies Record<PlaceDialRoad, string>,
  /** Its word while it is waiting on the answer: a pressed button keeps its variant and changes its word. */
  dialling: "Dialling…",
  /** What the app says when its own client carries no dial road, in place of a button that would ask nobody. A
   * whole sentence, because it stands after one in the pane's slot and a clause opening in lower case after a
   * full stop reads as a line that broke. */
  cannotDial: "This wsp cannot dial a computer from here.",
} as const;

/** What Add a computer says beyond PLACES_WORDS.sheet: the one field, why Add waits, and the two lines the
 * joined screen says. One road, so no word here names one. */
export const ADD_COMPUTER_WORDS = {
  cancel: "Cancel",
  login: "ssh login",
  loginPlaceholder: "root@host",
  /** The label on the row that carries the login while the install runs. */
  addon: "ssh",
  add: "Add",
  adds: "adds",
  loginFirst: "type the login first",
  /** Why Add is held on a wsp whose host cannot log in over ssh yet. */
  noRoad: "this wsp cannot log in over ssh yet",
  /** What to do about a login ssh would not take, short enough that what ssh said and this together stand on the
   * slot's two lines: a third line moves what is under them. There is no file picker on this road: the host reads
   * the ssh agent and config as they stand, so the key a box wants is named where every other ssh client reads it. */
  refusedFix: "Check the user and the address, or name a key in your ssh config.",
  running: "closing keeps it going",
  named: "Named after its hostname. Rename it from its row.",
  runsWorkspaces: "It runs your workspaces. Your image is built there the first time a workspace is created on it.",
} as const;

/** Both halves on the about row: the shell holding the page and the host that served it, which are one release run
 * together and two run apart. A browser tab has no shell of its own, so it shows the host's alone; a shell from
 * before the bridge carried a version has one this page cannot name. */
export function versionFact(app: string | undefined, host: string | undefined, inShell: boolean): string {
  const hostPart = `host ${host ?? "unknown"}`;
  return inShell ? `app ${app ?? "unknown"} · ${hostPart}` : hostPart;
}

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

/** The agents block under a computer's own row: one line per agent that computer has, the word for what stands
 * there, the sign-in that has no road from here, and the line for a computer that reported none. */
export const AGENTS_WORDS = {
  title: "Agents",
  /** An agent a joined computer reported on itself before any recipe ran there. */
  found: "found",
  signIn: "Sign in",
  /** Why that sign-in is held: nothing on the wire runs one on a computer from here, so the line names the
   * command that does, built from the row's own two names. */
  signInHeld: (computer: string, agent: string): string => `Sign in from a terminal for now: wsp add ${computer} --sign-in ${agent}`,
  /** An agent whose own config already names the wsp tools. */
  added: "wsp tools added",
  add: "Add the wsp tools",
  /** An agent wsp cannot hand the tools to at launch: its state, and no action beside it. The picker on the init
   * screens says the same of the same agent, so the word has one home. */
  noTools: CLOUD_SETUP_WORDS.choice.noTools,
  /** The line under a computer that reported no agent at all, whichever computer it is. */
  noneOn: (computer: string): string => `No agents found on ${computer}.`,
} as const;

/** What one row of the recipe on a computer came to, in the words the terminal's own lines say it in. The note a
 * row carries follows the word where it says why, which is a row that failed or was set aside. */
export const PROVISION_OUTCOME_WORDS: Record<PlaceProvisionRow["outcome"], string> = {
  installed: "installed",
  present: "already there",
  failed: "failed",
  skipped: "set aside",
};
