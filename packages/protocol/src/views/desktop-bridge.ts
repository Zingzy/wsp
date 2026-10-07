// SPDX-License-Identifier: AGPL-3.0-only

import type { OutsideLine } from "../outside-line.js";
import type { LinkTarget } from "../app-address.js";
import type { ThemePreference } from "./preferences.js";

// --- desktop shell bridge (preload to page) -----------------------------------

/** One installed font file the desktop shell hands the page for its terminal, registered under the family the file names. */
export interface LocalFontFace {
  family: string;
  weight: 400 | 700;
  style: "normal" | "italic";
  data: ArrayBuffer;
}

/** The one inline script the page carries, as the host writes the boot object into it and as a reader finds that
 * object again: the whole script element, with the object as its one group. Nothing else the host serves carries
 * this line, so finding it is the whole reading of whether a page came off a wsp host. */
export const BOOT_SCRIPT = /<script>window\.__WSP__ = ([^<]*);<\/script>/;

/** The boot object of a page a host served, or nothing where the page carries no such line, a line no wsp host
 * wrote, or one that does not parse. */
export function bootLineOf(html: string): BootPayload | undefined {
  const found = BOOT_SCRIPT.exec(html);
  if (found === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(found[1]!);
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as BootPayload).wsPath !== "string") return undefined;
    return parsed as BootPayload;
  } catch {
    return undefined;
  }
}

/** What the host writes into the page's one inline script as window.__WSP__ before serving it. */
export interface BootPayload {
  /** The sha256 of the host's own token, hex, inlined only on the loopback page: the desktop shell compares it to the
   * digest of the token file beside the state and sends nothing, so a page a squatter serves on the lock's port
   * cannot learn the token by being read. The token itself is never in any page: a browser here dials with a
   * device token wsp init or wsp host pair let it in with, and the shell hands its page the file's over the bridge. */
  tokenHash?: string;
  /** The path on this page's own origin the runtime WebSocket answers on, which is the one road a client reaching
   * the host through an ssh forward or a tunnel hostname has. */
  wsPath: string;
  /** True when this page was served on the computer the host runs on, which is the page's one reading of being at
   * home: false is a host on another computer, whose page pairs for a device token of its own. */
  paired: boolean;
  /** The release this host is, which is the release this page is: a desktop shell attached to a host it did not
   * start reads it to tell whether the two halves were built apart. */
  version: string;
  /** The family the person's terminal draws with, when the saved recipe ticks its row; the terminal pane defaults to it. */
  terminalFont?: string;
  /** The state file this host serves; the page keeps what it remembers (the workspace open last) under it. A page
   * served beyond loopback carries none, so every stranger's page remembers under one empty slot. */
  statePath?: string;
  /** Why this host sends no usage counts whatever the switch says, so the Privacy switch shows off with the reason and
   * the first run says nothing about them. Absent where the switch decides. */
  productUsageOff?: ProductUsageOff;
}

/** Why a host sends no usage counts: a build that carries no PostHog key, or ANALYTICS_ENV=0 where the host runs. */
export type ProductUsageOff = "build" | "env";

/** One row of a context menu as the page hands it to the desktop shell, which builds the native menu from it. An item
 * that cannot run right now is shown dimmed with its refusal as the hover text; rows of different groups are parted by
 * a separator. shortcut is the label the page shows, accelerator the same chord in Electron's spelling. */
export interface ContextMenuItem {
  id: string;
  label: string;
  group: string;
  enabled: boolean;
  refusal?: string;
  /** What a row that can run says on hover, where the label leaves something out a person would want before pressing
   * it. The two are one slot, read refusal first: a row is either dimmed with a reason or live with a word about
   * what it does, never both, which is the reading every button in the app already makes. */
  hint?: string;
  shortcut?: string;
  accelerator?: string;
  destructive?: boolean;
  /** A row that marks a state, drawn with a check when true; a row with no mark at all leaves this out. */
  checked?: boolean;
}

// --- hosts the desktop window can move between --------------------------------

/** One host on the account as the desktop lists it, by the alias wsp's command line names the same record by: never
 * the token. */
export interface HostListing {
  alias: string;
  url: string;
}

/** The hosts as the window shows them: the word for the app's own computer, which host the window is on (null for
 * that computer), and every saved host. */
export interface HostsView {
  here: string;
  current: string | null;
  hosts: HostListing[];
}

/** How a host move ended: done, or refused in the host's own words. */
export type HostOutcome = { ok: true } | { ok: false; error: string };

/** How the shell's fetch or open of a release's bundle ended: done, or refused in one line the page shows as it is. */
export type BundleOutcome = { ok: true } | { ok: false; error: string };

/** The class the desktop preload puts on the html element when the window has no title bar of its own: the app's
 * header row is the window's frame, the traffic lights sit in it and the sidebar shows the window's frosted glass. */
export const DESKTOP_MAC_CLASS = "desktop-mac";

/** The class the desktop preload puts on the html element where the shell draws the window controls over the page:
 * the header row is the window's frame and leaves the room the titlebar-area variables name for the controls. */
export const DESKTOP_WCO_CLASS = "wco";

/** A key press the desktop shell took from its own menu and handed to the page, spelled the way a keyboard event
 * spells it, so the page's one keybinding table answers it. */
export interface ShellChord {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}


/** What the desktop shell's preload puts on window.wsp; a browser tab has none of it. */
export interface DesktopBridge {
  /** The release this shell is, so a page served by a host of another one can say which half is behind. Absent on
   * a shell from before the bridge carried it, which is older than any page that reads this. */
  readonly version?: string;
  /** The words over Get on this shell's platform, from the shell's own bundle row; absent where none is built. */
  readonly bundleHover?: string;
  /** True where this shell replaces itself with a release: getBundle stages the release beside the app and
   * quitAndOpen restarts into it. Absent on every other shell, which keeps the disk image road. */
  readonly updatesInPlace?: boolean;
  /** Why an installed mac app cannot replace itself where it runs (from its disk image, a translocated copy, a folder
   * it cannot write), for the notice that a release is out; absent where it can, or where it never would. */
  readonly updateWhy?: string;
  /** The installed faces for a family and its Nerd Font variants, from this computer's font directories. */
  localFonts(family: string): Promise<LocalFontFace[]>;
  /** Every font family installed on this computer, by name: what the app and code font pickers offer. */
  fontFamilies(): Promise<string[]>;
  /** The system folder picker; the absolute path chosen, or nothing when it was dismissed. */
  pickFolder(): Promise<string | undefined>;
  /** The absolute path of a file or folder dropped on the window from the desktop, which the page itself cannot
   * read; nothing on a page served by a host somewhere else, which is handed no path from this computer. */
  droppedPath(file: File): string | undefined;
  /** The native context menu at the pointer, built from the items; resolves with the chosen item's id, or null when it was dismissed. */
  contextMenu(items: ContextMenuItem[]): Promise<string | null>;
  /** Photographs the page as it is now and keeps it under this workspace, replacing what that workspace held. Asked
   * for as the person leaves a workspace, while the page still shows it. */
  capturePreview(workspaceId: string): Promise<void>;
  /** The last photograph taken of this workspace, as a data url, or nothing when none was taken. */
  workspacePreview(workspaceId: string): Promise<string | undefined>;
  /** Whether a terminal holds focus, so the chords the shell's menu would zoom the window on stand aside for it. */
  setTerminalFocus(focused: boolean): void;
  /** A chord the shell stood aside from, for the page's keybindings to answer; returns the unsubscribe. */
  onShellChord(handler: (chord: ShellChord) => void): () => void;
  /** The theme the page draws, so the window's frame, glass and traffic-light bar follow it. */
  setTheme(theme: ThemePreference): void;
  /** Whether the page draws glass, so the window's own glass is on under it and off under a page drawn solid. */
  setGlass(glass: boolean): void;
  /** The page's theme moved: window controls the shell draws over the page take the header's ground and ink again,
   * read off the page's --titlebar-ground and --titlebar-ink. */
  setTitleBar(): void;
  /** Something the person should hear about outside the app (a build waiting, a machine up, a prompt, a finished
   * turn): the shell shows a system notification while its window has no focus, and nothing while it has, since the
   * page already says it. The page decides nothing about focus; the shell owns that. */
  sayOutside(line: OutsideLine): void;
  /** A click on that notification, after the shell has raised its window, with the id the page put on its line: the
   * page opens what it was about. Returns the unsubscribe. */
  onNeedsYouOpen(handler: (id?: string) => void): () => void;
  /** How many threads wait on the person, for the dock's badge; zero clears it. */
  setBadge(count: number): void;
  /** The person opened Usage: the plan alerts the dock's badge carries beside that count are taken off. */
  planAlertsSeen(): void;
  /** Whether this computer's service starts wsp at every login; null where no service is registered for this state.
   * Only the app's own host's page is answered. */
  loginStart(): Promise<boolean | null>;
  /** Sets that, leaving wsp running either way, and answers the reading after it. */
  setLoginStart(on: boolean): Promise<boolean | null>;
  /** A wsp:// link the system handed the shell while the page was up, read down to what it names: the page opens it
   * and does nothing to it. Only the app's own host's page is told. Returns the unsubscribe. */
  onOpen(handler: (target: LinkTarget) => void): () => void;
  /** The device token the shell holds for the host that served this page, when the window is on a host somewhere
   * else; nothing on the app's own host, whose page carries its own token. The token never rides in the page. */
  hostToken(): Promise<string | undefined>;
  /** The saved hosts and which one the window is on. */
  hosts(): Promise<HostsView>;
  /** Puts the window on a saved host, or on the app's own computer for null. */
  switchHost(alias: string | null): Promise<HostOutcome>;
  /** Downloads this release's bundle for this computer from the repo's release and keeps it only where its sha256
   * matches the one GitHub publishes. The version is all the page hands over; the shell builds every URL itself.
   * Where the shell updates in place, the bundle is the release's zip, unpacked and checked beside the app. */
  getBundle(ask: { version: string }): Promise<BundleOutcome>;
  /** Opens the bundle the last getBundle kept and quits the app, so the new one is never swapped in under a
   * running host; where the shell updates in place, quits and restarts into the new version instead. */
  quitAndOpen(): Promise<BundleOutcome>;
  /** Deletes the checked update a shell that updates in place holds, which the ready notice's Later asks for. */
  discardUpdate(): Promise<BundleOutcome>;
}
