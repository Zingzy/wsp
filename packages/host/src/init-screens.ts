// SPDX-License-Identifier: AGPL-3.0-only
// The five screens of wsp init as data, for a client that draws them itself:
// the app's modal. The rows come from the same builders the terminal's list
// draws (the agents table, the tools table, the manager scan, the sign-ins,
// the wsp tools), the ticks and answers from the same recipe, and an answer
// moves the recipe the way the terminal's screen moves it, so the two draw one
// state and the build reads one recipe.
import { CATALOG_AGENTS, CATALOG_TOOLS } from "@wsp/catalog";
import { floorApplies, type LoginChoice } from "@wsp/collect";
import { type InitFooterLine, type InitScreen, type InitScreenId, type InitScreenItem, type Recipe } from "@wsp/protocol";
import { ALSO_EMPTY, ALSO_EMPTY_TOP, ALSO_TITLE, ALSO_TOP, alsoItems, buildLine, scannedTicks, withScanned } from "./init-also.js";
import { AGENTS_TITLE, AGENTS_TOP, SIGN_INS_TITLE, SIGN_INS_TOP, TOOLS_TITLE, TOOLS_TOP, WSP_TITLE, WSP_TOP, diskFooter, pickEstimate, screenCounter, signInItems, tableItems, withAgents, withTools, wspToolsItems } from "./init-pick.js";
import { isLoginChoice } from "./init-recipe.js";
import type { FooterLine, SelectItem } from "./init-select.js";
import { FLOOR_LINE, agentRows, recipeTable, totalsLine } from "./init-table.js";
import { manifestFor, type Reading } from "./init.js";

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
}

/** Off a terminal the columns carry no paint, so a cell is its text. */
const NO_COLOUR = 1;

const text = (column: SelectItem["hint"]): string | undefined => (column === undefined ? undefined : typeof column === "string" ? column : column.text);

const item = (i: SelectItem): InitScreenItem => ({
  id: i.id,
  label: i.label,
  ...(text(i.hint) !== undefined ? { hint: text(i.hint)! } : {}),
  ...(text(i.why) !== undefined ? { why: text(i.why)! } : {}),
  ...(i.group !== undefined ? { group: i.group } : {}),
  detail: i.detail.filter(line => line !== ""),
  ...(i.lock !== undefined ? { lock: i.lock } : {}),
  ...(i.choices !== undefined ? { choices: i.choices.map(c => ({ value: c.value, label: c.label })) } : {}),
});

const footer = (lines: readonly FooterLine[]): InitFooterLine[] => lines.map(l => (typeof l === "string" ? { text: l } : { text: l.text, ...(l.tone !== undefined ? { tone: l.tone } : {}) }));

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
      items: tableItems(agents, recipe, manifest, NO_COLOUR, false).map(item),
      ticks: agents.filter(r => r.on).map(r => r.id),
      answers: {},
      footer: footer([totalsLine(recipeTable(withAgents(recipe, new Set(agents.filter(r => r.on).map(r => r.id))), CATALOG_AGENTS), "agents")]),
    },
    {
      id: "tools",
      title: TOOLS_TITLE,
      top: TOOLS_TOP,
      counter: screenCounter("tools"),
      items: tableItems(tools, recipe, manifest, NO_COLOUR, true).map(item),
      ticks: tools.filter(r => r.on).map(r => r.id),
      answers: {},
      footer: footer([totalsLine(tools, "tools"), ...(floorApplies(recipe.tick) ? [{ text: FLOOR_LINE }] : []), diskFooter(pickEstimate(manifest, recipe, reading.brew))]),
    },
    {
      id: "also",
      title: ALSO_TITLE,
      top: scan.length > 0 ? ALSO_TOP : ALSO_EMPTY_TOP,
      counter: screenCounter("also"),
      items: alsoItems(scan, recipe, row => buildLine(manifest, row, reading.brew)).map(item),
      ticks: [...scannedTicks(recipe, scan)],
      answers: {},
      footer: footer([diskFooter(pickEstimate(manifest, recipe, reading.brew))]),
      empty: ALSO_EMPTY,
    },
    {
      id: "logins",
      title: SIGN_INS_TITLE,
      top: SIGN_INS_TOP,
      counter: screenCounter("logins"),
      items: signIns.items.map(item),
      ticks: [],
      answers,
      footer: [],
    },
    {
      id: "wsp",
      title: WSP_TITLE,
      top: WSP_TOP,
      counter: screenCounter("wsp"),
      items: wsp.items.map(item),
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
