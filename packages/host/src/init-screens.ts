// SPDX-License-Identifier: AGPL-3.0-only
// The five screens of wsp init as data, for a client that draws them itself:
// the app's setup. The rows come from the same builders the terminal's list
// draws (the agents table, the tools table, the manager scan, the sign-ins,
// the wsp tools), the ticks and answers from the same recipe, and an answer
// moves the recipe the way the terminal's screen moves it, so the two draw one
// state and the build reads one recipe. Where the app's words differ from the
// terminal's (a tools row is one number, a sign-in row a mark, a file and a
// picker) they are set here, once.
import { basename } from "node:path";
import { CATALOG_AGENTS, CATALOG_TOOLS, agentName as catalogName, catalogEntry, hasLogin } from "@wsp/catalog";
import { floorApplies, type LoginChoice, type Manifest } from "@wsp/collect";
import { BUILDER_DISK_GB, isMcpRow } from "@wsp/engine";
import { CLOUD_SETUP_WORDS, fmtCalls, type InitScreen, type InitScreenId, type InitScreenItem, type Recipe } from "@wsp/protocol";
import { ALSO_EMPTY, ALSO_EMPTY_TOP, ALSO_TITLE, ALSO_TOP, alsoItems, buildLine, scannedTicks, withScanned } from "./init-also.js";
import { AGENTS_TITLE, AGENTS_TOP, SIGN_INS_TITLE, SIGN_INS_TOP, TOOLS_TITLE, TOOLS_TOP, WSP_TITLE, WSP_TOP, mcpAgents, pickEstimate, screenCounter, signInItems, tableItems, withAgents, withTools, wspToolsItems } from "./init-pick.js";
import { agentName, isLoginChoice, isTickable } from "./init-recipe.js";
import type { SelectItem } from "./init-select.js";
import { agentRows, recipeTable, type TableRow } from "./init-table.js";
import { manifestFor, type Reading } from "./init.js";
import { signInFor } from "./signin-table.js";

/** What the screens have settled so far: the recipe with its ticks, each sign-in row's answer, and the wsp tools rows
 * ticked once that screen was answered (undefined before, since an empty set is an answer of its own). */
export interface ScreenAnswers {
  recipe: Recipe;
  logins: Map<string, LoginChoice>;
  wspTicks: Set<string> | undefined;
}

export interface ScreensAt {
  statePath: string;
  home: string;
  /** The wsp home's .env as it stands, the one place a sign-in row reads whether its key is saved. */
  saved(): Readonly<Record<string, string>>;
}

/** The two groups of the app's tools screen: one divider says the base once, the rest reads as the person's usage. */
export const ALWAYS_GROUP = "always on the image";
export const USAGE_GROUP = "from your usage";

/** The app paints nothing, so a why cell is its sentence alone; under eight colours the terminal's cell carries the
 * group's word ahead of it, which on a screen would read the word twice. */
const PLAIN = 8;

const text = (column: SelectItem["hint"]): string | undefined => (column === undefined ? undefined : typeof column === "string" ? column : column.text);

const GIB = 1024 * 1024 * 1024;

/** A table row's size for the wire: the bytes, or null where the catalog measured none. */
const sizeOf = (row: TableRow | undefined): number | null => row?.size ?? null;

const item = (i: SelectItem, size?: number | null): InitScreenItem => ({
  id: i.id,
  label: i.label,
  ...(size !== undefined ? { size } : {}),
  ...(text(i.why) !== undefined ? { why: text(i.why)! } : {}),
  ...(i.group !== undefined ? { group: i.group } : {}),
  detail: i.detail.filter(line => line !== ""),
  ...(i.lock !== undefined ? { lock: i.lock } : {}),
  ...(i.choices !== undefined ? { choices: i.choices.map(c => ({ value: c.value, label: c.label })) } : {}),
});

/** How often the agents ran a tool here, from the recipe row the table row came from; nothing where it was not used. */
const callsOf = (recipe: Recipe, id: string): number | undefined => {
  const source = recipe.rows.find(r => r.id === id)?.source;
  return source?.kind === "used" ? source.calls : undefined;
};

/** The tools screen's rows as the app draws them: the base under one divider, everything else under the person's
 * usage, each usage row carrying its calls alone, most first; the tick says what the rule decided. */
function toolItems(tools: readonly TableRow[], recipe: Recipe, manifest: Manifest): InitScreenItem[] {
  const detail = new Map(tableItems(tools, recipe, manifest, PLAIN, true).map(i => [i.id, i.detail]));
  const rows = tools.map(row => ({ row, calls: callsOf(recipe, row.id) }));
  const byCalls = (a: { calls: number | undefined }, b: { calls: number | undefined }): number => (b.calls ?? -1) - (a.calls ?? -1);
  const shaped = ({ row, calls }: (typeof rows)[number], group: string): InitScreenItem => ({
    id: row.id,
    label: row.name,
    size: sizeOf(row),
    ...(calls !== undefined ? { why: fmtCalls(calls) } : {}),
    group,
    detail: (detail.get(row.id) ?? []).filter(line => line !== ""),
    ...(row.base ? { lock: "on" as const } : {}),
  });
  return [...rows.filter(r => r.row.base).map(r => shaped(r, ALWAYS_GROUP)), ...rows.filter(r => !r.row.base).sort(byCalls).map(r => shaped(r, USAGE_GROUP))];
}

/** The variable a sign-in row's agent reads an API key from, declared once on the agent's sign-in; nothing for a row
 * whose tool signs in another way. */
export function keyNameFor(manifest: Pick<Manifest, "entries">, rowId: string): string | undefined {
  const e = manifest.entries.find(x => x.id === rowId);
  if (e === undefined || e.rung !== "logins") return undefined;
  const s = signInFor(agentName(e));
  return hasLogin(s) ? s.keyEnv : undefined;
}

/** A path on this computer as the sign-ins screen names it: the file's own name, or the Keychain item's label. */
const shortSource = (path: string): string => (path.startsWith("Keychain: ") ? "Keychain" : basename(path));

/** The sign-ins screen's rows as the app draws them: the source column is the short file name (the full path rides
 * in the detail), an MCP row names its agents, a row the build cannot sign in is a state word with skip fixed, and an
 * agent row whose agent takes a key says which variable and whether the home holds one. */
function loginItems(items: readonly SelectItem[], manifest: Manifest, saved: Readonly<Record<string, string>>): InitScreenItem[] {
  return items.map((i): InitScreenItem => {
    const e = manifest.entries.find(x => x.id === i.id);
    const base = item(i);
    if (e === undefined) return base;
    const where = e.paths.length > 0 ? e.paths.map(shortSource).join(", ") : undefined;
    const fixed = (i.choices ?? []).length === 1;
    const state = fixed ? (isTickable(e) ? CLOUD_SETUP_WORDS.screen.notOnImage : (e.reason ?? CLOUD_SETUP_WORDS.screen.leftAlone)) : undefined;
    const key = keyNameFor(manifest, i.id);
    const why = isMcpRow(e) ? mcpAgents(e, manifest).map(catalogName).join(", ") : where;
    return {
      ...base,
      mark: agentName(e),
      ...(why !== undefined && why !== "" ? { why } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(key !== undefined ? { key: { name: key, saved: (saved[key] ?? "") !== "" } } : {}),
      detail: [...(e.paths.length > 0 ? [e.paths.join(", ")] : []), ...base.detail.filter(line => !e.paths.includes(line) && line !== e.paths.join(", "))],
    };
  });
}

/** What the image's disk holds before any tick, and the disk the build asks the provider for: the base the room
 * leaves out of the builder's disk, plus the files that travel. The ring the app draws grows from here. */
export function diskOf(reading: Reading, recipe: Recipe, statePath: string): { fixed: number; total: number } {
  const est = pickEstimate(manifestFor(reading, recipe, statePath), recipe, reading.brew);
  const total = BUILDER_DISK_GB * GIB;
  return { fixed: total - est.room + est.files, total };
}

/** The five screens as they stand for these answers, in the terminal's order and numbering. */
export function screensOf(reading: Reading, a: ScreenAnswers, at: ScreensAt): InitScreen[] {
  const manifest = manifestFor(reading, a.recipe, at.statePath);
  const { recipe, logins } = a;
  const agents = agentRows(recipe);
  const tools = recipeTable(recipe, CATALOG_TOOLS);
  const scan = reading.scanned;
  const signIns = signInItems(manifest, reading.brew);
  const wsp = wspToolsItems(recipe, at.home);
  const answers = Object.fromEntries([...signIns.initial].map(([id, choice]): [string, string] => [id, logins.get(id) ?? choice]));
  return [
    {
      id: "agents",
      title: AGENTS_TITLE,
      top: AGENTS_TOP,
      counter: screenCounter("agents"),
      items: tableItems(agents, recipe, manifest, PLAIN, false).map(i => item(i, sizeOf(agents.find(r => r.id === i.id)))),
      ticks: agents.filter(r => r.on).map(r => r.id),
      answers: {},
      footer: [],
      tally: "agents",
    },
    {
      id: "tools",
      title: TOOLS_TITLE,
      top: TOOLS_TOP,
      counter: screenCounter("tools"),
      items: toolItems(tools, recipe, manifest),
      ticks: tools.filter(r => r.on).map(r => r.id),
      answers: {},
      footer: [],
      tally: "tools",
    },
    {
      id: "also",
      title: ALSO_TITLE,
      top: scan.length > 0 ? ALSO_TOP : ALSO_EMPTY_TOP,
      counter: screenCounter("also"),
      tally: "more",
      items: alsoItems(scan, recipe, row => buildLine(manifest, row, reading.brew)).map(i => item(i, scan.find(r => r.id === i.id)?.size ?? null)),
      ticks: [...scannedTicks(recipe, scan)],
      answers: {},
      footer: [],
      empty: ALSO_EMPTY,
    },
    {
      id: "logins",
      title: SIGN_INS_TITLE,
      top: SIGN_INS_TOP,
      counter: screenCounter("logins"),
      items: loginItems(signIns.items, manifest, at.saved()),
      ticks: [],
      answers,
      footer: [],
    },
    {
      id: "wsp",
      title: WSP_TITLE,
      top: WSP_TOP,
      counter: screenCounter("wsp"),
      items: wsp.items.map(i => item(i)),
      ticks: [...(a.wspTicks === undefined ? wsp.initial : new Set([...a.wspTicks].filter(id => wsp.items.some(i => i.id === id))))],
      answers: {},
      footer: [],
      empty: "no agent here takes the wsp tools yet",
    },
  ];
}

/** The answers with one screen answered: ticks move the recipe as that screen's own step does, a sign-in answer is
 * kept only when it is one of the four the wire knows. */
export function answerScreen(reading: Reading, a: ScreenAnswers, screen: InitScreenId, answer: { ticks?: readonly string[]; answers?: Readonly<Record<string, string>> }): ScreenAnswers {
  const ticks = new Set(answer.ticks ?? []);
  switch (screen) {
    case "agents":
      return { ...a, recipe: withAgents(a.recipe, ticks) };
    case "tools":
      return { ...a, recipe: withTools(a.recipe, ticks) };
    case "also":
      return { ...a, recipe: withScanned(a.recipe, reading.scanned, ticks) };
    case "logins": {
      const logins = new Map(a.logins);
      for (const [id, choice] of Object.entries(answer.answers ?? {})) if (isLoginChoice(choice)) logins.set(id, choice);
      return { ...a, logins };
    }
    case "wsp":
      return { ...a, wspTicks: ticks };
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
}
