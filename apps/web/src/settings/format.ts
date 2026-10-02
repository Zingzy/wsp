// SPDX-License-Identifier: AGPL-3.0-only
// The words the settings page and its palette row say, one place, keyed by the
// preference value where a value has words of its own.
import { fmtPx, listWords, offlineFor, placeUpdateLine, type MidTurn, type NotifyChoice, type OnQuit, type PlaceDialRoad, type PlaceProvisionRow, type SendKey, type SettleAfter, type TerminalSizeSource, type ThemePreference } from "@wsp/protocol";

/** The muted mono a state word or a description of machine words wears, and the foreground mono a value a person
 * reads wears: an address, a size, a path, a time, a version. Two class strings the page, the sheet and the first
 * run all draw with, so one type ladder holds across them. */
export const FACT = "font-mono text-[13px] tabular-nums text-muted-foreground";
export const VALUE = "font-mono text-sm tabular-nums text-foreground";

/** A fact's slot where its words may take two lines: exactly two of the line's own line heights, held whether the
 * words take one line or two, and cut at the second with the whole on the element's hover text. The height is read
 * off the line itself (2lh) rather than written as a figure, so a slot and the text in it cannot disagree by the
 * half pixel that moved the first run's button between one line and two. */
export const TWO_LINE_SLOT = "min-h-[2lh] line-clamp-2";

export const SETTINGS_WORDS = {
  title: "Settings",
  search: "Search settings",
  searchPage: "Search",
  nothingMatches: "Nothing matches.",
  back: "Back",
  backTo: (group: string): string => `Back to ${group}`,
  restore: "Restore defaults",
  resetRow: "Back to the default",
  appearance: "Appearance",
  theme: "Theme",
  mode: "Mode",
  /** The grid of one side's themes, named by the side's word. */
  themesOf: (side: string) => `${side} themes`,
} as const;

/** Settings > Appearance, the two font rows. */
export const FONT_WORDS = {
  head: "Type",
  lede: "The faces and sizes the conversation and its code are read in.",
  app: "App font",
  appDescription: "The sidebar, replies and every page.",
  code: "Code font",
  codeDescription: "Code in replies, the changes and files.",
  default: "Default",
  textSize: "Reading size",
  textSizeDescription: "Replies, your own messages and the box you write in.",
  codeSize: "Code size",
  codeSizeDescription: "Code in replies, tool output, the changes and files.",
  px: (size: number): string => `${size} px`,
  /** What the samples under the type rows say: a reply with a line of code, in the faces and sizes picked. */
  sample: "The total rounded each line on its own, so three lines at 0.335 came to 1.00 or 1.01. It now rounds once:\n\n```ts\nexport const total = (lines: Line[]) => round(lines.reduce((sum, l) => sum + l.price, 0));\n```",
} as const;

/** Settings > Appearance's theme section. */
export const THEME_SECTION_WORDS = {
  lede: "Point at a theme to see this window in it.",
  modeLede: (here: string): string => `Light, dark, or whichever side ${here === "" ? "this computer" : here} is on.`,
} as const;

/** Settings > Appearance's glass section, which holds the Transparency switch. */
export const GLASS_WORDS = {
  head: "Glass",
  lede: "How wsp's window shows what is behind it.",
} as const;

/** Each side as its segment names it. */
export const THEME_WORDS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** A sentence that names the computer the host runs on, said only once that name is known: until the places list
 * arrives it is empty, since a stand-in word flashed in its place would be text that is not true. */
export const onceNamed = (here: string, sentence: (here: string) => string): string => (here === "" ? "" : sentence(here));

/** What a fact says after it about where it is, " on <name>", or nothing while the name is not known yet, so no line
 * is left ending on a dangling "on". */
export const onName = (name: string): string => onceNamed(name, n => ` on ${n}`);

/** What the Computers pages say beyond the words the wire already carries in PLACES_WORDS: the list row, a
 * computer's own page, its agents and the Remove dialog, which are this build's and are drawn nowhere else. No
 * word is in both. */
export const WHERE_WORDS = {
  runningHere: (n: number): string => (n === 0 ? "Nothing running" : `${n} ${n === 1 ? "thread" : "threads"} running`),
  /** A place list the host refused, said where the list would stand. */
  notRead: (said: string) => `Computers not read: ${said}`,
  /** Puts this wsp's daemon on that computer and runs the recipe there again. One word in both states, held and
   * dimmed while it runs: a label that changed to Updating moved the button's own width. */
  update: "Update",
  default: "default",
  remove: "Remove",
  removeTitle: (computer: string): string => `Remove ${computer}`,
  removeDescription: (computer: string, here: string): string => onceNamed(here, h => `wsp comes off ${computer} and its threads' records leave ${h}. Your files there stay.`),
  removeCloudDescription: "Deletes every machine wsp made there and forgets the key.",
  removing: "Removing…",
  cancel: "Cancel",
  /** Why a row's action is held: the op that carries it is not on the wire yet. */
  notYet: "not on this wsp yet",
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
  cannotSaveKey: "This wsp cannot save a key from here.",
  /** The first cell of each list's header row, which is the only name a section has. */
  heads: { computer: "Computer", cores: "Cores", memory: "Memory", threads: "Threads", cloud: "Cloud", agents: "Agents", version: "Version", servers: "MCP servers", image: "Image", threadsHere: "Threads running here" },
  yourImage: "Your image",
} as const;

/** A word as the first of a sentence or a state: its first letter capitalised, the rest as written. */
export const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** A row's state as the list's state cell says it: one capitalised word, the whole sentence on its hover. */
export const PLACE_STATE_WORDS = {
  ready: "Ready",
  blocked: "Blocked",
  building: (at: { index: number; of: number } | undefined): string => (at === undefined ? "Building" : `Building ${at.index}/${at.of}`),
  stopped: "Stopped",
  failed: "Failed",
  behind: "Behind",
  signIn: "Sign in",
  needsSignIn: (agents: readonly string[]): string => `needs a sign-in: ${agents.join(", ")}`,
} as const;

/** What Add a computer says beyond PLACES_WORDS.sheet and the roads' own names. */
export const ADD_COMPUTER_WORDS = {
  title: "Add a computer",
  addCloud: "Add a cloud",
  user: "User",
  host: "Host",
  hostPlaceholder: "box.example.com or an ssh alias",
  port: "Port",
  addComputer: "Add computer",
  whatHappens: "What happens",
  replace: "Replace",
  adding: "Adding",
  another: "Add another",
  signInsOn: (computer: string): string => `Sign-ins on ${computer}`,
  signInsWhy: (agents: readonly string[], computer: string): string =>
    `${new Intl.ListFormat("en", { type: "conjunction" }).format(agents)} ${agents.length === 1 ? "keeps" : "keep"} one login for every workspace on ${computer}, so sign in once here.`,
  suggested: "From your ssh config",
  copy: "Copy",
  copied: "Copied",
  notCopied: "not copied",
  replaceKey: "Paste a new key to replace it",
  /** Said only once the host lists that cloud as a computer: a key kept is not yet a place to fork on. */
  keySaved: "key saved",
  keyKept: "key kept; no computer yet",
  getKey: "Get a key",
  /** The first key for a cloud is an add: the key check and the cloud's row both follow it. */
  add: "Add",
  checking: "Checking",
  keyRefused: (provider: { name: string; keyConsole?: string }): { said: string; fix: string } => ({
    said: `${provider.name} refused that key.`,
    fix: provider.keyConsole === undefined ? "Check it and paste it again." : `Check it at ${provider.keyConsole} and paste it again.`,
  }),
  hostsNotRead: (said: string): string => `Hosts from your ssh config not read: ${said}`,
  installThere: "On that computer, install wsp",
  joinThere: "Then run",
  minting: "making a code",
  codeLeft: (ms: number): string => {
    const seconds = Math.ceil(ms / 1000);
    return `code works for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  },
  expired: "code expired",
  newCode: "New code",
  noMint: "this wsp cannot make a join line from the app yet",
  adds: "adds",
  /** Why Add is held on a wsp whose host cannot log in over ssh yet. */
  noRoad: "this wsp cannot log in over ssh yet",
  /** What to do about a login ssh would not take, short enough that what ssh said and this together stand on the
   * slot's two lines: a third line moves what is under them. There is no file picker on this road: the host reads
   * the ssh agent and config as they stand, so the key a box wants is named where every other ssh client reads it. */
  refusedFix: "Check the user and the address, or name a key in your ssh config.",
  running: "closing keeps it going",
  /** An add the host no longer lists while nothing here waits on it: the host restarted, or never got the ask. */
  hostLost: "The host lost track of this add, so how it ended is not known; add it again if the computer is not listed.",
} as const;

/** Each size source as its segment names it: whole at every width, since a cut segment is a defect. */
export const TERMINAL_SIZE_WORDS: Record<TerminalSizeSource, string> = {
  app: "App",
  file: "Ghostty file",
};

/** The size the picked source hands the pane, as the word beside the control: the app's own size, or the file's,
 * which is the app's again for a file that names none. */
export const TERMINAL_SIZE_FACT: Record<TerminalSizeSource, (appPx: number, filePx: number | undefined) => string> = {
  app: appPx => fmtPx(appPx),
  file: (appPx, filePx) => fmtPx(filePx ?? appPx),
};

/** Settings > Account: the one row that says who this wsp is signed in to and what a sign-in buys. The second
 * sentence is why the button is held: no op on the wire signs the app in yet. There is no word for being signed
 * in or not: the button standing there is that state. Nothing about the account is said anywhere else in the
 * window. */
export const ACCOUNT_WORDS = {
  title: "Account",
  github: "GitHub",
  signIn: "Sign in with GitHub",
  signOut: "Sign out",
  reach: "Sign in to use this wsp from outside your network. Not from the app yet.",
  reachable: "Reachable from another device outside your network. Not from the app yet.",
} as const;

/** Settings > General. */
export const GENERAL_WORDS = {
  composer: "Composer",
  sendWith: "Send with",
  sendWithDescription: "The other key makes a new line. Keys read as this computer's: ⌘ on a Mac, Ctrl elsewhere.",
  sendKeys: (mac: boolean): Record<SendKey, string> => ({ enter: "Enter", "mod-enter": mac ? "⌘ Enter" : "Ctrl Enter" }),
  midTurn: "A message while a thread works",
  midTurnDescription: "Queue waits for the turn to end; steer hands it to the agent now.",
  midTurnChoices: { queue: "Queue", steer: "Steer" } satisfies Record<MidTurn, string>,
  notifications: "Notifications",
  notifyNeeds: "When a thread needs you",
  notifyNeedsDescription: "A question, a permission prompt, a sign-in.",
  notifyDone: "When a thread finishes",
  notifyDoneDescription: "Off keeps ten running threads from pinging you ten times.",
  notifyChoices: { off: "Off", notify: "Notify", sound: "Sound", "notify-sound": "Notify and sound" } satisfies Record<NotifyChoice, string>,
  planAlerts: "When a plan window runs low",
  planAlertsDescription: "At 70% and 90% of a window, once each, and when an account is blocked.",
  threads: "Threads",
  settleAfter: "Settle a thread after",
  settleAfterDescription: "A read thread moves to Settled once it has been quiet this long.",
  settleChoices: { "15m": "15 minutes", "1h": "1 hour", "2h": "2 hours", "1d": "1 day", never: "Never" } satisfies Record<SettleAfter, string>,
  askDelete: "Ask before deleting",
  askDeleteDescription: "A workspace with unpushed work always asks.",
  openIn: "Open in",
  editor: "Open files in",
  editorDescription: "Where Open in editor goes, for a file in a thread or a whole workspace.",
  noEditor: "No editor wsp opens files in is installed: VS Code, Cursor, Zed or a JetBrains IDE.",
  startup: "Startup and quit",
  onQuit: "When you quit",
  onQuitDescription: (here: string): string => `Quitting the window leaves threads running on ${here === "" ? "this computer" : here}; quit and stop ends them too.`,
  onQuitChoices: { ask: "Ask each time", keep: "Keep threads running", stop: "Stop wsp too" } satisfies Record<OnQuit, string>,
  loginStart: "Start wsp at login",
  loginStartDescription: (here: string): string => `wsp keeps running on ${here === "" ? "this computer" : here} with no window open, so threads carry on.`,
} as const;

export const PRIVACY_WORDS = {
  title: "Privacy",
  serverIcons: "Server icons from Google",
  serverIconsDescription: "wsp asks Google for each public server's icon by host name; turning this off deletes the saved icons.",
  agentVersions: "Newest agent versions",
  agentVersionsDescription: "wsp asks npm, GitHub and each agent's maker for every agent's newest version, once a day.",
  agentVersionsHeld: "Off on the host: WSP_UPDATE_CHECK is 0.",
  usageLogs: "Agent logs",
  usageLogsDescription: (here: string): string => `Usage counts what Claude Code, Codex and OpenCode logged on ${here === "" ? "this computer" : here}, wsp's own threads there included. wsp reads the logs there and shows what they count on the Usage page alone, never to an agent.`,
} as const;

/** Settings > Appearance's switch over the app's glass. */
export const TRANSPARENCY_WORDS = {
  title: "Transparency",
  description: "Glass shows what is behind the window. Off, every surface is solid.",
} as const;

/** Settings > General's switch over the desktop app keeping this computer awake. */
export const AWAKE_WORDS = {
  keepAwake: (here: string): string => `Keep ${here === "" ? "this computer" : here} awake`,
  keepAwakeDescription: "The wsp app stops this computer sleeping on its own while a thread works on it.",
} as const;

/** Settings > Devices: every computer and browser paired with this wsp, and the one act on each. */
export const DEVICES_WORDS = {
  title: "Devices",
  thisBrowser: "this browser",
  paired: (when: string): string => `paired ${when}`,
  seen: (seen: string): string => `seen ${seen} ago`,
  /** A device this wsp heard from inside the minute: the span reads 0 min, which says nothing a person asked. */
  seenNow: "seen just now",
  revoke: "Revoke",
  revokeTitle: (name: string): string => `Revoke ${name}?`,
  revokeDescription: "It can no longer reach this wsp until it pairs again.",
  none: "Nothing is paired with this wsp yet.",
  /** A page served on a ticket socket is refused the list. */
  refused: "Who is paired is read on the computer running wsp.",
} as const;

/** Settings > Agents: its title, the computer it reads and its three lists. */
export const AGENTS_PAGE_WORDS = {
  title: "Agents",
  computer: "Computer",
  tab: "Show",
  tabs: { agents: "Agents", servers: "Tool servers", skills: "Skills" },
  onComputer: (name: string): string => `Agents, tool servers and skills on ${name}`,
  onComputerDescription: "Installed agents, their sign-ins, and the tools and skills they get.",
  newThreads: "New threads",
  defaultAgent: "Default agent",
  defaultAgentDescription: "A project can set its own.",
  on: (name: string): string => `On ${name}`,
  notInstalled: "Not installed here",
  notInstalledShort: "Not installed",
  checkedNow: (when: string): string => `checked ${when}`,
  readAgain: "Read the agents again",
  /** A model at the effort a new thread runs it at. */
  atEffort: (model: string, effort: string | undefined): string => (effort === undefined ? model : `${model} at ${effort.toLowerCase()} effort`),
  /** An access word as its own quiet fact. */
  accessFact: (word: string): string => `${word.toLowerCase()} access`,
  update: "Update",
  updateTo: (version: string): string => `Update to ${version}`,
  updateCopied: (command: string, computer: string): string => `Copied ${command}. Run it in a terminal on ${computer}.`,
  turnOn: (agent: string, computer: string): string => `${agent} on ${computer}`,
  model: "Model",
  modelDescription: "The composer still changes it for one thread.",
  effort: "Effort",
  access: "Access",
  accessDescription: (agent: string): string => `A project can set its own. Passed to ${agent} at every launch.`,
  accessWords: { ask: "Ask", "auto-edit": "Auto-edit", full: "Full", plan: "Plan" },
  models: "Models in the picker",
  modelsDescription: "Hide the ones you never use, put yours first, add one by id.",
  modelsShown: (shown: number, all: number): string => `${shown} of ${all}`,
  edit: "Edit",
  change: "Change",
  howItRuns: "How it runs",
  program: "Program",
  configFolder: "Config folder",
  ownFolder: (agent: string): string => `${agent}'s own folder`,
  launchArguments: "Launch arguments",
  argumentsCount: (n: number): string => (n === 0 ? "No arguments." : `${n} ${n === 1 ? "argument" : "arguments"}.`),
  environment: "Environment",
  variablesCount: (n: number): string => (n === 0 ? "No variables." : `${n} ${n === 1 ? "variable" : "variables"}, values hidden.`),
  save: "Save",
  cancel: "Cancel",
  putBack: (agent: string): string => `Use ${agent}'s own`,
  programSheet: (agent: string, computer: string): string => `The program run in ${agent}'s place on ${computer}: a path, or a word on its PATH.`,
  configSheet: (agent: string, computer: string): string => `The folder on ${computer} ${agent} keeps its config, sessions and sign-in in, under that computer's home.`,
  argumentsSheet: (agent: string, computer: string): string => `Words added to every launch of ${agent} on ${computer}, as a shell would split them.`,
  argumentsUnclosed: "A quote is never closed.",
  environmentSheet: (agent: string, computer: string): string => `Variables every launch of ${agent} on ${computer} carries. A value is typed here once and never shown again.`,
  variableName: "Name",
  variableValue: "Value",
  addVariable: "Add",
  removeVariable: (name: string): string => `Remove ${name}`,
  noVariables: "No variables yet.",
  modelsSheet: (agent: string): string => `The models ${agent}'s picker lists, in its order. A hidden model still runs when a thread names it.`,
  moveUp: (model: string): string => `Move ${model} up`,
  moveDown: (model: string): string => `Move ${model} down`,
  shown: (model: string): string => `Show ${model}`,
  modelId: "Model id",
  addModel: "Add",
  removeModel: (model: string): string => `Remove ${model}`,
} as const;

/** Settings > Usage: its title and the words the lists carry beyond the wire's own in USAGE_WORDS. */
export const USAGE_PAGE_WORDS = {
  title: "Usage",
  tabs: { used: "Usage", limits: "Limits" },
  tab: "Show",
  limits: "Limits",
  session: "Session",
  week: "Week",
  used: "Used",
  tokens: "Tokens",
  range: "Range",
  split: "Split by",
  fresh: "Fresh in",
  out: "Out",
  cached: "Cached",
  price: "Price",
  noAccounts: "No agent is signed in on any computer.",
  windows: { session: "5-hour", week: "Week", week_opus: "Week, Opus", week_sonnet: "Week, Sonnet", month: "Month" } as Partial<Record<string, string>>,
  reached: "Limit reached",
  left: "left",
  runsOut: (when: string): string => `Runs out ${when}`,
  aheadOfPace: (resets: string): string => `Ahead of pace${resets === "" ? "" : `, ${resets}`}`,
  underPace: (resets: string): string => `Under pace${resets === "" ? "" : `, ${resets}`}`,
  onPace: (resets: string): string => `On pace${resets === "" ? "" : `, ${resets}`}`,
  accounts: (n: number, agent: string): string => `${n} ${agent} accounts`,
  burn: (tokens: string, threads: number): string => `Using ${tokens} tokens a minute across ${threads} ${threads === 1 ? "thread" : "threads"}`,
  checked: (when: string): string => `checked ${when}`,
  noPlanLimit: "No plan limit",
  noLimit: (agents: readonly string[]): string => `${listWords(agents)} ${agents.length === 1 ? "reports" : "report"} no plan limit.`,
  ranges: { day: "Today", week: "7 days", month: "30 days" },
  splits: { agent: "Agent", account: "Account", computer: "Computer", project: "Project", model: "Model" },
  estimate: "API estimate",
  atListPrice: "at list price",
  turns: "Turns",
  turnsNote: "in threads wsp ran",
  cacheHit: "Cache hit",
  saved: (amount: string): string => `${amount} saved`,
  cacheWrite: "Cache write",
  fromCache: (share: string): string => `${share} read from cache`,
  chartHead: { day: "Tokens an hour", week: "Tokens a day", month: "Tokens a day" },
  by: (split: string): string => `By ${split.toLowerCase()}`,
  mix: "Where the tokens went",
  agentAndModel: "Agent and model",
  allOf: { agent: "All agents together", account: "All accounts together", computer: "All computers together", project: "All projects together", model: "All models together" },
} as const;

/** Settings > Projects: the list, a project's own page and its one act. */
export const PROJECTS_WORDS = {
  look: "Look",
  about: "About",
  icon: "Icon",
  iconDescription: "Drawn beside the project in the sidebar and the switcher.",
  hue: "Colour",
  hueDescription: "The icon's colour, so the project reads at a glance.",
  title: "Projects",
  add: "Add a project",
  on: (computer: string): string => `on ${computer}`,
  none: "No projects yet.",
  noneDescription: "A project is a folder on one of your computers.",
  source: "Source",
  sourceHover: "The folder or repository this project is.",
  computer: "Computer",
  computerHover: "Where the project lives and where its tasks run.",
  remote: "Remote",
  repository: "Repository",
  open: "Open",
  where: (source: string, computer: string): string => `${source} on ${computer}`,
  threads: (n: number, running: number): string => `${n} ${n === 1 ? "thread" : "threads"}${running === 0 ? "" : `, ${running} running`}`,
  remoteHover: "The repository it was cloned from.",
  added: "Added",
  addedHover: "When it was recorded.",
  seeded: "Seeded",
  seededHover: (here: string): string => onceNamed(here, h => `What the seed carried from ${h}, once.`),
  newWorkspaces: "New tasks",
  branch: "Branch",
  branchDescription: "Where a new task starts.",
  lastAgent: "Last agent",
  lastAgentDescription: "What a new thread on it defaults to.",
  remove: "Remove",
  removeTitle: (name: string): string => `Remove ${name}`,
  removeAsk: (name: string): string => `Remove ${name}?`,
  /** One line by the computer's kind, matching the runtime's three landings. */
  removeHere: "Its record leaves this wsp. Your folder stays as it is.",
  removeOnComputer: (computer: string): string => `Its record leaves this wsp, and wsp's own clone of it on ${computer} goes with it.`,
  removeAtCloud: (cloud: string): string => `Its record leaves this wsp, and its image at ${cloud} with it.`,
  newThreads: "New threads in this project",
  defaultAgent: "Default agent",
  model: "Model",
  access: "Access",
  agentSet: "Set here for this project. The arrow goes back to the default for every project.",
  agentUnset: "Unset, so a new thread takes the default for every project.",
  ownSet: "Set here for this project. The arrow goes back to the agent's own.",
  ownUnset: "Unset, so a new thread takes the agent's own.",
  inherits: (value: string, from?: string): string => (from === undefined ? `Default (${value})` : `Default (${value}, from ${from})`),
} as const;

/** Settings > Keybindings: the four cards' heads and the three keys that are not rules. */
export const KEYBINDINGS_WORDS = {
  title: "Keybindings",
  windowAndPanels: "Window and panels",
  workspacesAndThreads: "Tasks and threads",
  terminal: "Terminal, while it has focus",
  fixed: "Fixed",
  sendMessage: "Send the message",
  submitComment: "Submit a review comment",
  leaveSettings: "Leave Settings",
} as const;

/** Settings > General's Version card: the two halves of one release, and the road to the next. */
export const ABOUT_WORDS = {
  title: "Version",
  wsp: "wsp",
  upToDate: "Up to date",
  available: (version: string): string => `${version} is out`,
  checking: "Checking for updates",
  checksOff: "Update checks are off",
  notChecked: "Not checked yet",
  whatsNew: "What's new",
  app: "App",
  appHover: "The desktop shell holding this window.",
  host: "Host",
  hostHover: "The wsp that serves this page.",
  unknown: "unknown",
  releases: "Releases",
  latest: "Latest",
  readWhen: (ms: number): string => (ms < 60_000 ? "just now" : `${offlineFor(ms)} ago`),
  readHover: (when: string): string => `Read from the releases page ${when}.`,
  missedHover: (when: string, at: string): string => `Read ${when}; the releases page was not reached ${at}.`,
  unreachedHover: (at: string): string => `The releases page was not reached ${at}.`,
  offHover: "Update checks are off on the host: WSP_UPDATE_CHECK is 0.",
  computersBehind: "Computers behind",
  behindHover: (names: readonly string[]): string => `${names.join(", ")}: ${placeUpdateLine(names.length === 1 ? names[0]! : "<name>")}`,
  get: (version: string): string => `Get ${version}`,
  downloading: "Downloading",
  quitAndOpen: "Quit and open",
  restartHost: "Restart host",
  restartHover: "Drops open terminal panes, localhost forwards and any sign-in in progress; running turns continue.",
  restartRuns: "Restart host runs them.",
  restartThere: "A restart on the computer it runs on runs them.",
  hostUpdateHover: (line: string, version: string): string => `The wsp that serves this page. ${line} gets ${version}.`,
  hostInstalledHover: (installed: string, then: string): string => `The wsp that serves this page. Its files carry ${installed} now. ${then}`,
} as const;

/** What one row of the recipe on a computer came to, in the words the terminal's own lines say it in. The note a
 * row carries follows the word where it says why, which is a row that failed or was set aside. */
export const PROVISION_OUTCOME_WORDS: Record<PlaceProvisionRow["outcome"], string> = {
  installed: "installed",
  present: "already there",
  failed: "failed",
  skipped: "set aside",
};

/** A computer's own page: whether it runs an older wsp, the limits a person sets on it, and whether its threads may
 * open threads. `here` is the name of the computer the host runs on, never "this Mac". */
export const COMPUTER_PAGE_WORDS = {
  behindTitle: (here: string): string => `Runs an older wsp than ${here}`,
  behindUpdate: (name: string, here: string): string => `Threads still run there. Updating installs ${here}'s version on ${name} and restarts it; running threads carry on.`,
  behindHereTitle: "Runs an older wsp than this app",
  behindInstall: (fix: string): string => `Threads still run. Run ${fix} in a terminal to bring it level.`,
  update: (name: string): string => `Update wsp on ${name}`,
  updating: "Updating",
  limits: "Limits",
  threadsAtOnce: "Threads at once",
  threadsLine: (n: number, name: string, mem: string): string => `New threads wait past this. The default is one thread for every 2.5 GB of this computer's memory, so ${n} on ${name}'s ${mem}.`,
  threadsLineBare: "New threads wait past this.",
  fewer: "One fewer",
  more: "One more",
  napTitle: "Nap a quiet workspace after",
  napLine: "A workspace with no running turn stops and wakes on the next message.",
  napNever: "Never",
  threadsHere: "Threads here",
  spawnTitle: "Agents may start agents",
  spawnLine: (machines: number, depth: number): string => `A thread here may open threads of its own: up to ${machines} ${machines === 1 ? "machine" : "machines"}, ${depth === 1 ? "one level deep" : `${depth} levels deep`}.`,
} as const;

/** The Limits tab's banked resets line: what is banked, and the one act that spends one after asking. */
export const RESET_LINE_WORDS = {
  resets: "Resets",
  use: "Use reset",
  using: "Using reset",
  cancel: "Cancel",
} as const;
