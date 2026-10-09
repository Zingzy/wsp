// SPDX-License-Identifier: AGPL-3.0-only
// The Settings page: every group the sidebar draws, in its order, with each card's rows as the app states them under
// the default preferences, and the themes. A card whose rows are the person's own records says what it lists instead.
import { DEFAULT_PREFERENCES, HERE_PLACE_ID, type PlaceView } from "@wsp/protocol";
import { FONT_WORDS, SETTINGS_WORDS, THEME_WORDS } from "../../../apps/web/src/settings/format.js";
import { drawnGroups } from "../../../apps/web/src/settings/groups.js";
import type { SettingsCardData, SettingsItem } from "../../../apps/web/src/settings/rows.js";
import type { SettingsContext } from "../../../apps/web/src/settings/settingsContext.js";
import { NO_READS } from "../../../apps/web/src/settings/settingsStore.js";
import { SIDE_DEFAULT, THEMES } from "../../../apps/web/src/themes/index.js";
import { cell, page, table, type Generated } from "./generated.js";

/** The computer the host runs on, so a sentence that names it reads whole; no other computer and no project. */
const HERE: PlaceView = { id: HERE_PLACE_ID, kind: "computer", name: "your computer", default: true };
const none = (): void => {};

/** The desktop app on a Mac with default preferences, before any record of the person's own has been read. */
const CTX: SettingsContext = {
  preferences: DEFAULT_PREFERENCES,
  places: [HERE],
  pending: [],
  recipes: 0,
  placesRefused: null,
  projectsRefused: null,
  projects: [],
  harnesses: [],
  workspaces: [],
  sessions: {},
  statuses: {},
  landings: {},
  reads: { ...NO_READS, loginStart: true, sshInclude: false },
  now: 0,
  shell: { inShell: true, app: undefined, host: undefined },
  release: null,
  platform: "MacIntel",
  desktopShell: true,
  api: null,
  go: none,
  setPreferences: none,
  openAddComputer: none,
  addAsked: null,
  agentsPlace: null,
  askAdd: none,
  openAddProject: none,
  rereadDevices: none,
  failed: none,
  done: none,
};

/** What a card lists in place of its rows, by the card's id, where the rows are the person's own records. A sentence
 * that also speaks for a sibling card names it in `also`, so a test can hold it to the cards the app draws. */
export const LISTS: Record<string, { says: string; also?: readonly string[] }> = {
  version: { says: "The version this wsp runs, whether a newer release is out, and the button that gets it. What's new opens the release notes." },
  agents: { says: "Pick the computer to read and a tab: Agents, Tool servers or Skills. Agents starts with the default agent a new thread runs on, which a project can override, then one row per agent there with its version, its sign-in and what a new thread runs it with. Each row opens its own page." },
  computers: { says: "One row per computer this wsp runs on. Each row opens that computer's page: its state, its agents and tool servers, its image, the threads running there, and Remove." },
  recipes: { says: "One row per recipe: its icon, what it holds and the computers that follow it. An open recipe has the same rows Add a computer ticks, and a change there reaches every computer following it." },
  projects: { says: "One row per project, with its source and the computer it lives on. Each opens the project's page: its facts, what a new task starts from, its icon and color, and Remove, which waits until no workspace uses it." },
  usage: { says: "Two tabs. Usage: what turns used over a range, split by a value you pick, with the threads that used the most. Limits: each signed-in account with what its agent last said about its plan's windows." },
  devices: { says: "Every computer and browser paired with this wsp, with when it paired and when it was last seen, and Revoke." },
};

/** What a row's control shows; under the default preferences, the default. Blank where the control is not a choice. */
function shown(control: unknown): string {
  if (typeof control !== "object" || control === null || !("props" in control)) return "";
  const p = control.props as { checked?: unknown; value?: unknown; segments?: { value: unknown; label: string }[]; words?: Record<string, string>; children?: unknown };
  if (typeof p.checked === "boolean") return p.checked ? "On" : "Off";
  if (p.segments !== undefined) return p.segments.find(s => s.value === p.value)?.label ?? "";
  if (p.words !== undefined && typeof p.value === "string") return p.words[p.value] ?? "";
  if ("value" in p && (p.value === "" || p.value === undefined)) return FONT_WORDS.default;
  return shown(p.children);
}

/** What the two pickers Appearance draws whole, rather than as a row's control, start on, by card. */
const PICKED: Record<string, string> = {
  mode: THEME_WORDS[DEFAULT_PREFERENCES.theme],
  theme: `${SIDE_DEFAULT.light.word} on the light side, ${SIDE_DEFAULT.dark.word} on the dark`,
};

const themes = (): string =>
  table(["Theme", "Side", "What it looks like"], THEMES.map(t => [t.word, THEME_WORDS[t.side], cell(t.line)]));

const rowOf = (item: SettingsItem): [string, string, string] =>
  item.kind === "row" ? [item.title, typeof item.description === "string" ? item.description : item.description.join(", "), shown(item.control)] : [item.label, item.hover ?? "", ""];

function cardText(card: SettingsCardData): string {
  // The theme card's head names the side the window is on now.
  const head = card.id === "theme" ? "Themes" : card.head;
  const parts = [head ? `### ${head}` : "", card.lede ? cell(card.lede) : ""];
  const listed = LISTS[card.id];
  const picked = PICKED[card.id];
  if (listed !== undefined) return [...parts, listed.says].filter(Boolean).join("\n\n");
  if (picked !== undefined) return [...parts, `Default: ${picked}.`, card.id === "theme" ? themes() : ""].filter(Boolean).join("\n\n");
  const rows = card.items.filter(item => item.kind === "row" || item.empty !== true).map(rowOf);
  if (rows.length === 0) throw new Error(`the settings card ${card.id} draws no row here: say what it lists in LISTS`);
  const cols = rows.some(r => r[2] !== "") ? ["Setting", "What it does", "Default"] : ["Setting", "What it does"];
  return [...parts, table(cols, rows.map(r => r.slice(0, cols.length).map(cell)))].filter(Boolean).join("\n\n");
}

/** Runs `read` with a window stub: Appearance reads the system's side off the window, which node has none of. */
function withWindow<T>(read: () => T): T {
  const held = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) } as unknown as typeof window;
  try {
    return read();
  } finally {
    globalThis.window = held;
  }
}

/** The id of every card the app draws under the page's context, group by group. */
export const drawnCards = (): string[] => withWindow(() => drawnGroups().flatMap(group => group.cards(CTX).map(card => card.id)));

export default function settings(): Generated[] {
  const groups = drawnGroups();
  return withWindow(() => {
    const sections = groups.map(group => {
      if (group.id === "keybindings") {
        const heads = group.cards(CTX).flatMap(card => (card.head ? [card.head] : []));
        return `## ${group.name}\n\nOne line per command, in cards headed ${heads.map(h => `*${h}*`).join(", ")}. A command's keys are a button that sets a chord of your own. Every command and its keys on Mac and Linux are on [Keyboard shortcuts](/features/shortcuts).`;
      }
      const cards = group.cards(CTX).map(cardText);
      return [`## ${group.name}`, ...cards].join("\n\n");
    });
    const restorable = groups.filter(group => group.restore !== undefined).map(group => group.name);
    const intro = [
      `Settings has one page per group, in the order its sidebar lists them: ${groups.map(g => g.name).join(", ")}. A row off its default shows an arrow by its title that puts it back. ${new Intl.ListFormat("en").format(restorable)} also have ${SETTINGS_WORDS.restore}, which puts back the whole page.`,
      "A default below is what the app shows before you change anything, read on the desktop app on a Mac.",
    ];
    return [page("content/features/settings.mdx", "Settings", "settings.ts", [...intro, ...sections].join("\n\n"))];
  });
}
