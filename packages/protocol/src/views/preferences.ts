// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { CLOUD_ENV, LABS_ENV } from "../env.js";
import { AgentDefaults, AgentDefaultsPatch, ProjectOverrides, ProjectOverridesPatch, patchedFields } from "../thread-defaults.js";
import { GENERAL_DEFAULTS, GENERAL_FIELDS, patchedGeneral } from "../general-prefs.js";
import { ProjectHue, ProjectIcon, ProjectIconHash } from "../project-look.js";
import { ThreadView } from "./session.js";
import { SessionEvent } from "./session-events.js";

// --- preferences (the person's view of the app, kept on the host so every client agrees) ---

/** Which side of the stylesheet the page draws: the computer's own, or one side pinned. */
export const ThemePreference = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/** Which body the sidebar draws: every workspace and its threads, or Spaces, one workspace at a time. */
export const SidebarMode = z.enum(["list", "spaces"]);
export type SidebarMode = z.infer<typeof SidebarMode>;

/** Where the terminal pane's text size comes from before a zoom moves it: the app's own size, or the size the person's Ghostty file names. */
export const TerminalSizeSource = z.enum(["app", "file"]);
export type TerminalSizeSource = z.infer<typeof TerminalSizeSource>;

/** The last target: the workspace a thread was last started on. A workspace holds one project, so the workspace
 * is the whole of the answer. */
export const PreferencesTarget = z.object({ workspace: z.string() }).strict();
export type PreferencesTarget = z.infer<typeof PreferencesTarget>;

/** One record on the host's state; the desktop app and a browser tab on the same host read and write this one. sidebarWidth
 * absent is the sidebar's own default; terminalZoom is the pixels a workspace's panes add to the base size, by workspace id. */
/** How one project is drawn: its glyph and its hue, each the default where absent. */
export const ProjectLook = z.object({ icon: ProjectIcon.optional(), hue: ProjectHue.optional() }).strict();
export type ProjectLook = z.infer<typeof ProjectLook>;
/** The glyphs a computer can wear on the Computers page; the app maps each word to its drawing. */
export const ComputerIcon = z.enum(["laptop", "desktop", "mac-mini", "mac-studio", "tower", "server", "cloud", "cpu", "drive", "container", "home"]);
export type ComputerIcon = z.infer<typeof ComputerIcon>;
export const ComputerLook = z.object({ icon: ComputerIcon }).strict();
export type ComputerLook = z.infer<typeof ComputerLook>;
/** How one recipe is drawn: the glyph the person picked from the projects' set. */
export const RecipeLook = z.object({ icon: ProjectIcon }).strict();
export type RecipeLook = z.infer<typeof RecipeLook>;

/** A theme's id, one per side. The shape is checked here; which ids exist is the app's registry, which reads an id it
 * does not know as that side's default, so a theme added later needs nothing from the host. */
export const ThemeId = z.string().min(1);
/** A chord as the app spells it; which keys exist is the app's to say. */
const ChordText = z.string().min(1).max(64);
/** A font family by name, as the computer's font list or a person's typing names it. */
const FontFamily = z.string().max(128);
/** Each side's theme before a person picks one. */
const THEME_PICK_DEFAULTS = { lightTheme: "paper", darkTheme: "graphite" } as const;

/** The editors a file on the computer running the host can open in, the one table the host's opener is keyed by:
 * the host lists the ones installed there and runs its own command for each, never a command a client names.
 * Finder is the Mac's own and reveals the file rather than opening it. */
export const EditorId = z.enum(["vscode", "cursor", "vscode-insiders", "zed", "idea", "webstorm", "pycharm", "goland", "rustrover", "clion", "phpstorm", "rubymine", "rider", "finder"]);
export type EditorId = z.infer<typeof EditorId>;
/** One editor installed on the computer the host runs on; `remote` where it also opens a workspace on another
 * computer over ssh. */
export const EditorChoice = z.object({ id: EditorId, name: z.string(), remote: z.literal(true).optional() });
export type EditorChoice = z.infer<typeof EditorChoice>;

/** What Open in editor says for a workspace whose files are on another machine, named as the person reads it. */
export const editorOpensHereLine = (name: string): string => `These files are on ${name}, so they open here.`;
/** editor.open on a workspace on another computer before the person's ssh config reads wsp's: the window asks them
 * for that one line with the refusal's kind, and opens again once it stands. */
export const sshIncludeLine = (name: string): string => `${name} opens in your editor over ssh, which needs one line at the top of ~/.ssh/config.`;
/** ssh.port on a copy on this computer: its folder is right here, so an editor opens it with no ssh at all. */
export const sshCopyHereLine = (name: string): string => `${name} is a copy on this computer, so its folder opens here with no ssh.`;
/** The kind an Open carries when the workspace's computer runs a daemon from before ssh.start: a wait for that
 * daemon's update, which a running turn there holds back, and not a failure. */
export const SSH_BEHIND_KIND = "sshBehind";
export const sshBehindLine = (name: string): string => `${name}'s computer runs an older wsp; it updates when its running turn ends, then Open works.`;
/** The refusal for ssh.port and ssh.include on a socket let in on a ticket: the port is on this computer's loopback,
 * and the Include is in the person's own ssh config. */
export const SSH_TICKET_REFUSAL = "a socket let in on a ticket cannot reach a workspace's ssh; use the wsp command or the app on the computer the host runs on";
/** The refusal for editor.list and editor.open on a socket let in on a ticket: a program starts only for this computer's
 * own window, and the list of what could start is read on the same terms. */
export const EDITOR_TICKET_REFUSAL = "a socket let in on a ticket cannot list or open the editors on this computer; use the app on the computer the host runs on";

/** The sizes a person may read the conversation and its code at, in px. Each surface keeps its own size until one is
 * picked. */
export const TEXT_SIZES = [13, 14, 15, 16, 17] as const;
export const CODE_SIZES = [11, 12, 13, 14, 15] as const;
const sizeOf = (sizes: readonly number[]) => z.number().int().refine(n => sizes.includes(n), { message: `one of ${sizes.join(", ")}` });

export const Preferences = z.object({
  theme: ThemePreference,
  /** Each side's pick. Defaulted rather than required, so a record from a host older than the picks still parses on the
   * wire and does not blank every other preference. */
  lightTheme: ThemeId.default(THEME_PICK_DEFAULTS.lightTheme),
  darkTheme: ThemeId.default(THEME_PICK_DEFAULTS.darkTheme),
  sidebarMode: SidebarMode,
  sidebarWidth: z.number().int().positive().optional(),
  terminalSize: TerminalSizeSource,
  terminalZoom: z.record(z.string(), z.number().int()),
  /** The access mode the composer last picked in a workspace, by workspace id, in the harness's own slug. It is on
   * this record rather than in one browser's storage because the host reads it too: a thread opened with no access
   * named runs at the person's last pick for that workspace, whichever client or CLI opened it. Keyed by workspace
   * alone, as the composer's other picks are, so it is read through listedPick: a workspace's threads may run on
   * either harness and their mode lists are disjoint, and a pick the harness in front of us does not take drops to
   * that harness's own default rather than refusing the send. */
  access: z.record(z.string(), z.string()),
  /** The workspace a thread was last started on anywhere: where a new thread asked for from nowhere goes. Absent
   * until the first start. */
  target: PreferencesTarget.optional(),
  /** How each project is drawn, by project id; kept here so every screen that opens this wsp draws it the same. */
  projectLook: z.record(z.string(), ProjectLook),
  /** The image each project wears over its glyph, by project id, as the hash of the PNG the host keeps under the wsp
   * home. Apart from the look, so a hue change or a recipe's move cannot drop it and a reader that predates it drops
   * the key rather than the record; written by projects.icon alone, so no client names a hash the host does not hold. */
  projectIcon: z.record(z.string(), ProjectIconHash).default({}),
  /** How each computer is drawn, by place id. Defaulted rather than required, so a record from a host that kept no
   * icons still parses on the wire and does not blank every other preference. */
  computerLook: z.record(z.string(), ComputerLook).default({}),
  /** How each recipe is drawn, by its slug. Absent until one is picked, so a record from a host that kept none reads
   * as it always did. */
  recipeLook: z.record(z.string(), RecipeLook).optional(),
  /** The leads whose Threads section a person shut, by the lead's thread id; apart from the sidebar's fold of the
   * same tree. Absent until one is shut, and a write keeps only the leads the host still holds. */
  threadsShut: z.record(z.string(), z.literal(true)).optional(),
  /** Whether the host asks Google for each remote MCP server's icon by its host name. On unless the person turns it
   * off; defaulted so a record from a host older than the switch reads as on. */
  serverIcons: z.boolean().default(true),
  /** Whether the host asks each agent's vendor for its newest version. On unless the person turns it off, and
   * WSP_UPDATE_CHECK=0 in the host's environment stops it whatever this says; defaulted as serverIcons is. */
  agentVersions: z.boolean().default(true),
  /** Whether the host has each computer's daemon read that computer's agent logs for the work done outside wsp, which
   * the Usage page counts on rows of their own. Read there and kept here; defaulted as serverIcons is. */
  usageLogs: z.boolean().default(true),
  /** Whether the host sends PostHog anonymous counts of what wsp did: threads, turns, computers, setups and failures,
   * never a path, a prompt, a name or a key. On unless the person turns it off, and ANALYTICS_ENV=0 in the host's
   * environment stops it whatever this says; defaulted as serverIcons is. */
  productUsage: z.boolean().default(true),
  /** The editor Open in editor opens a file in; absent opens the first one installed on the computer running the host. */
  editor: EditorId.optional(),
  /** The release whose card in the sidebar the person dismissed, so no window shows it again; a newer one shows. */
  updateDismissed: z.string().optional(),
  /** Whether the desktop app keeps this computer from sleeping on its own while a thread works on it. On unless the
   * person turns it off; defaulted so a record from a host older than the switch reads as on. */
  keepAwake: z.boolean().default(true),
  /** Whether the app's glass shows what is behind it. Off, every glass takes its solid ground; on by default, and
   * defaulted so a record from a host older than the switch reads as on. */
  transparency: z.boolean().default(true),
  /** The order the person dragged the projects into, by id; a project it does not name follows in the host's order. */
  projectOrder: z.array(z.string()),
  /** The person's own chord for a command, by command id, in the app's chord spelling (mod+shift+b): it replaces every
   * default chord that command has. Which commands and chords exist is the app's, so the shape alone is checked here. */
  keybindings: z.record(z.string(), ChordText).default({}),
  /** The family the app's text and its code are drawn in, empty for the system stack. The terminal keeps its own. */
  appFont: FontFamily.default(""),
  codeFont: FontFamily.default(""),
  /** The size replies, the person's own messages and the composer read at; absent, each its own. */
  textSize: sizeOf(TEXT_SIZES).optional(),
  /** The size code reads at in replies, tool output, diffs and files; absent, each its own. */
  codeSize: sizeOf(CODE_SIZES).optional(),
  /** The agent a new thread runs when neither its start nor its project names one; absent is the catalog's first. */
  defaultAgent: z.string().optional(),
  /** The person's model, effort, access and model picker for each agent, by catalog id; the same on every computer. */
  agentDefaults: z.record(z.string(), AgentDefaults).default({}),
  /** What each project overrides for the threads opened on it, by project id. */
  projectDefaults: z.record(z.string(), ProjectOverrides).default({}),
  ...GENERAL_FIELDS,
  /** Whether the surfaces still being worked on are offered at all. The host stamps it from its own environment at
   * every read, so no client sets it and nothing a state file holds can turn it on. */
  labs: z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;

/** Whether labs is on in an environment: LABS_ENV set to exactly 1, and nothing else counts. */
export const labsFromEnv = (env: Record<string, string | undefined>): boolean => env[LABS_ENV] === "1";

/** Whether the cloud is on in an environment: CLOUD_ENV set to exactly 1, and nothing else counts. */
export const cloudFromEnv = (env: Readonly<Record<string, string | undefined>>): boolean => env[CLOUD_ENV] === "1";

/** What preferences.set takes: any of the record's fields but labs, which is the host's to say, and projectIcon,
 * which projects.icon writes; a null sidebarWidth clears it back to the default, terminalZoom and access name only
 * the workspaces they move, a null entry dropping
 * that workspace's zoom or pick, keybindings names only the commands it moves, a null entry putting that command
 * back on its defaults, and a null target clears the last target. Strict, so a field this record dropped
 * is refused rather than written into a state file nothing reads. */
export const PreferencesPatch = Preferences.omit({ labs: true, projectIcon: true })
  .partial()
  .extend({
    sidebarWidth: z.number().int().positive().nullable().optional(),
    terminalZoom: z.record(z.string(), z.number().int().nullable()).optional(),
    access: z.record(z.string(), z.string().nullable()).optional(),
    projectLook: z.record(z.string(), ProjectLook.nullable()).optional(),
    computerLook: z.record(z.string(), ComputerLook.nullable()).optional(),
    recipeLook: z.record(z.string(), RecipeLook.nullable()).optional(),
    threadsShut: z.record(z.string(), z.literal(true).nullable()).optional(),
    target: PreferencesTarget.nullable().optional(),
    keybindings: z.record(z.string(), ChordText.nullable()).optional(),
    textSize: sizeOf(TEXT_SIZES).nullable().optional(),
    codeSize: sizeOf(CODE_SIZES).nullable().optional(),
    defaultAgent: z.string().nullable().optional(),
    agentDefaults: z.record(z.string(), AgentDefaultsPatch.nullable()).optional(),
    projectDefaults: z.record(z.string(), ProjectOverridesPatch.nullable()).optional(),
  })
  .strict();
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", ...THEME_PICK_DEFAULTS, sidebarMode: "list", terminalSize: "app", terminalZoom: {}, access: {}, projectLook: {}, projectIcon: {}, computerLook: {}, serverIcons: true, agentVersions: true, usageLogs: true, productUsage: true, keepAwake: true, transparency: true, projectOrder: [], keybindings: {}, appFont: "", codeFont: "", agentDefaults: {}, projectDefaults: {}, ...GENERAL_DEFAULTS, labs: false };

/** The record as stored, over the defaults; a record that does not parse (an older or a hand-edited state file) reads as the defaults. */
export function preferencesFrom(stored: unknown): Preferences {
  const parsed = Preferences.partial().safeParse(stored ?? {});
  if (!parsed.success) return DEFAULT_PREFERENCES;
  const { projectIcon, ...patch } = parsed.data;
  return { ...applyPreferencesPatch(DEFAULT_PREFERENCES, patch), projectIcon: projectIcon ?? {} };
}

/** The record with the patch's fields over it. The one merge rule, read by the host that keeps the record and the client
 * that paints ahead of the host's answer, so both land on the same record. */
export function applyPreferencesPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  const sidebarWidth = patch.sidebarWidth === undefined ? current.sidebarWidth : patch.sidebarWidth;
  const perWorkspace = <T,>(kept: Record<string, T>, moved: Record<string, T | null> | undefined): Record<string, T> => {
    const next = { ...kept };
    for (const [workspaceId, value] of Object.entries(moved ?? {})) {
      if (value === null) delete next[workspaceId];
      else next[workspaceId] = value;
    }
    return next;
  };
  const target = patch.target === undefined ? current.target : patch.target;
  const editor = patch.editor ?? current.editor;
  const updateDismissed = patch.updateDismissed ?? current.updateDismissed;
  const textSize = patch.textSize === undefined ? current.textSize : patch.textSize;
  const codeSize = patch.codeSize === undefined ? current.codeSize : patch.codeSize;
  const defaultAgent = patch.defaultAgent === undefined ? current.defaultAgent : patch.defaultAgent;
  const recipeLook = patch.recipeLook === undefined ? current.recipeLook : perWorkspace(current.recipeLook ?? {}, patch.recipeLook);
  const threadsShut = patch.threadsShut === undefined ? current.threadsShut : perWorkspace(current.threadsShut ?? {}, patch.threadsShut);
  const fieldsById = <T extends object>(kept: Record<string, T>, moved: Record<string, { [K in keyof T]?: T[K] | null } | null> | undefined): Record<string, T> => {
    const next = { ...kept };
    for (const [id, value] of Object.entries(moved ?? {})) {
      const merged = value === null ? undefined : patchedFields(next[id], value);
      if (merged === undefined) delete next[id];
      else next[id] = merged;
    }
    return next;
  };
  return {
    theme: patch.theme ?? current.theme,
    lightTheme: patch.lightTheme ?? current.lightTheme,
    darkTheme: patch.darkTheme ?? current.darkTheme,
    sidebarMode: patch.sidebarMode ?? current.sidebarMode,
    terminalSize: patch.terminalSize ?? current.terminalSize,
    terminalZoom: perWorkspace(current.terminalZoom, patch.terminalZoom),
    access: perWorkspace(current.access, patch.access),
    projectLook: perWorkspace(current.projectLook, patch.projectLook),
    projectIcon: current.projectIcon,
    computerLook: perWorkspace(current.computerLook, patch.computerLook),
    serverIcons: patch.serverIcons ?? current.serverIcons,
    agentVersions: patch.agentVersions ?? current.agentVersions,
    usageLogs: patch.usageLogs ?? current.usageLogs,
    productUsage: patch.productUsage ?? current.productUsage,
    keepAwake: patch.keepAwake ?? current.keepAwake,
    transparency: patch.transparency ?? current.transparency,
    projectOrder: patch.projectOrder ?? current.projectOrder,
    keybindings: perWorkspace(current.keybindings, patch.keybindings),
    appFont: patch.appFont ?? current.appFont,
    codeFont: patch.codeFont ?? current.codeFont,
    agentDefaults: fieldsById(current.agentDefaults, patch.agentDefaults),
    projectDefaults: fieldsById(current.projectDefaults, patch.projectDefaults),
    ...patchedGeneral(current, patch),
    labs: current.labs,
    ...(sidebarWidth === null || sidebarWidth === undefined ? {} : { sidebarWidth }),
    ...(target === null || target === undefined ? {} : { target }),
    ...(editor === undefined ? {} : { editor }),
    ...(updateDismissed === undefined ? {} : { updateDismissed }),
    ...(textSize === null || textSize === undefined ? {} : { textSize }),
    ...(codeSize === null || codeSize === undefined ? {} : { codeSize }),
    ...(defaultAgent === null || defaultAgent === undefined ? {} : { defaultAgent }),
    ...(recipeLook === undefined ? {} : { recipeLook }),
    ...(threadsShut === undefined ? {} : { threadsShut }),
  };
}

/** What a set that turned server icons off answers when their folder would not go: the record is kept all the same. */
export const serverIconsLeftLine = (folder: string, reason: string): string =>
  `Server icons are off, but ${folder} could not be deleted: ${reason}. Delete it by hand.`;

/** A thread's read or settled stamp or one of its marks moved, by any window, or its snooze ended: the workspace's
 * rows are read again to pick it up. */
export const ThreadMarkedEvent = z.object({ type: z.literal("thread.marked"), workspaceId: z.string(), threadIds: z.array(z.string()) });
export type ThreadMarkedEvent = z.infer<typeof ThreadMarkedEvent>;

/** What the composer and the top bar draw of a thread with no event in sight: the thread as foldThreads lists it, less
 * its subagents, with the model, effort and context window its latest turn runs on and the running turn's id while one
 * runs. The subagents stay with sessions.list: a builder's list grows by every turn, and every head pushed is kept in
 * the bus's replay ring, where carrying it cost a day of turns 1.4 MB (measured). */
export const ThreadFacts = ThreadView.omit({ subagents: true }).extend({
  model: z.string().optional(),
  effort: z.string().optional(),
  contextWindow: z.string().optional(),
  turnId: z.string().optional(),
});
export type ThreadFacts = z.infer<typeof ThreadFacts>;

/** The bytes of JSON a thread's head answers in, facts and events together: a first paint's worth, which a click on a
 * thread's tile draws without waiting on the rest. */
export const HEAD_BYTES = 64 * 1024;
/** The characters of a tool result a head keeps; every reader of a result in a first paint reads its first lines. */
export const HEAD_RESULT_CHARS = 2 * 1024;
/** How many events a history page answers when the caller names no limit, and the most it may name. */
export const HISTORY_PAGE_EVENTS = 200;
export const HISTORY_PAGE_MAX = 1000;
/** The bytes of JSON a history page stops at, past its first event: a transcript keeps tool results of up to 16 KB,
 * so a page bounded by its count alone could be megabytes. */
export const HISTORY_PAGE_BYTES = 400 * 1024;

/** A thread's head: its facts and the newest of its events, oldest first, cut to what a first paint needs, with every
 * tool result past its first characters cut and marked. pos is the newest position the workspace's transcript has
 * issued, so an event off the bus at or under it is one the head already counts; total is how many events of the
 * thread the transcript holds. */
export const ThreadHead = z.object({
  facts: ThreadFacts,
  events: z.array(SessionEvent),
  pos: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ThreadHead = z.infer<typeof ThreadHead>;

/** One page of a thread's events out of sessions.history: the newest ones under `before`, oldest first, with pos and
 * total as ThreadHead carries them. */
export const HistoryPage = z.object({
  events: z.array(SessionEvent),
  pos: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

/** A thread's facts moved: a turn started or ended, or its title or access changed. It carries the facts and the
 * transcript's pos, never events, since every event of the thread rides the bus on its own. */
export const ThreadHeadEvent = z.object({
  type: z.literal("thread.head"),
  workspaceId: z.string(),
  threadId: z.string(),
  facts: ThreadFacts,
  pos: z.number().int().nonnegative(),
});
export type ThreadHeadEvent = z.infer<typeof ThreadHeadEvent>;

/** A thread was rewound, or a rewind undone: its transcript lost the turns after the one it kept, so every window
 * holding the thread reads its history and its rows again. */
export const ThreadRewoundEvent = z.object({ type: z.literal("thread.rewound"), workspaceId: z.string(), threadId: z.string() });
export type ThreadRewoundEvent = z.infer<typeof ThreadRewoundEvent>;

/** The host's record changed, by any client; every socket gets the whole record. */
export const PreferencesChangedEvent = z.object({ type: z.literal("preferences.changed"), preferences: Preferences });
export type PreferencesChangedEvent = z.infer<typeof PreferencesChangedEvent>;
