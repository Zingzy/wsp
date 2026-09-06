// SPDX-License-Identifier: AGPL-3.0-only
// The screens of wsp init on the catalog: the agents (the six, the ones on
// this Mac ticked), what they need (one line of counts and the disk line, the
// row list behind one key), and the sign-ins and keys (logins that sign in on
// the machine after the build listed, keys ticked to copy). The recipe is the
// state: catalog ids with a tick each; the collector's rows follow it.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { Prompt, isCancel } from "@clack/core";
import { S_BAR, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_SUBMIT } from "@clack/prompts";
import { CATALOG_AGENTS, CATALOG_TOOLS, type CatalogEntry, type ToolEntry, catalogEntry } from "@wsp/catalog";
import type { LoginChoice, Manifest, ManifestEntry } from "@wsp/collect";
import { MEASURED_ON, estimateDisk, parseMcpId, type BrewTable, type DiskEstimate } from "@wsp/engine";
import { MCP_ID_PREFIX, fmtBytes, type Recipe, type RecipeRow } from "@wsp/protocol";
import { GUTTER, S_BAR_FOCUS, S_BAR_FOCUS_END, colourDepth, helpLine, isTTY, widthOf, wrap, type HelpKey } from "./init-layout.js";
import { agentName, applyRecipe, comingRows, defaultAnswers, initialChoice, isTickable, loginShown, loginTool, rowsHere } from "./init-recipe.js";
import { rungSelect, type FooterLine, type SelectItem } from "./init-select.js";
import { diskLine, diskTone } from "./init-weight.js";
import { hasLogin, signInFor } from "./signin-table.js";

export const AGENTS_TITLE = "Agents";
export const NEED_TITLE = "What they need";
export const SIGN_INS_TITLE = "Sign-ins and keys";
/** The word over the floor rows on the tools list: they are on every machine, whatever is ticked. */
export const BASE_WORD = "in the base";
/** The word over the logins that run on the machine after the build; nothing here changes them. */
export const MACHINE_WORD = "sign in on the machine after the build";

const dim = (s: string): string => styleText("dim", s);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const rowOf = (recipe: Recipe, id: string): RecipeRow | undefined => recipe.rows.find(r => r.id === id);

/** Where a tool's tick comes from, in the words the screen uses: the base for a floor row, else its recipe source. */
export type SourceWord = typeof BASE_WORD | "installed here" | "used by your agents" | "popular in the catalog";
const SOURCE_ORDER: readonly SourceWord[] = [BASE_WORD, "installed here", "used by your agents", "popular in the catalog"];

export function sourceWord(e: ToolEntry, r: RecipeRow | undefined): SourceWord {
  if (e.floor) return BASE_WORD;
  switch (r?.source.kind) {
    case "installed":
      return "installed here";
    case "used":
      return "used by your agents";
    default:
      return "popular in the catalog";
  }
}

/** Whether a tool is on the machine with this recipe: a floor row always, any other by its tick. */
export const toolOn = (e: ToolEntry, r: RecipeRow | undefined): boolean => e.floor || r?.on === true;

/** The screen's one line: how many tools are on and where each tick came from, the sources in a fixed order. */
export function needLine(recipe: Recipe): string {
  const counts = new Map<SourceWord, number>();
  for (const e of CATALOG_TOOLS) {
    const r = rowOf(recipe, e.id);
    if (!toolOn(e, r)) continue;
    const word = sourceWord(e, r);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const on = [...counts.values()].reduce((a, b) => a + b, 0);
  const parts = SOURCE_ORDER.flatMap(w => (counts.has(w) ? [`${counts.get(w)} ${w}`] : []));
  return `${plural(on, "tool")}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

/** The recipe with one kind's rows ticked as a screen left them: a row the recipe had keeps its source, an entry it
 * never named gets a row on the catalog's own evidence, so a tick on a fresh Mac is kept. */
function withTicks(recipe: Recipe, kind: RecipeRow["kind"], entries: readonly CatalogEntry[], on: (id: string) => boolean): Recipe {
  const rows = recipe.rows.map(r => (r.kind === kind ? { ...r, on: on(r.id) } : r));
  const missing = entries.filter(e => !rows.some(r => r.id === e.id)).map((e): RecipeRow => ({ id: e.id, kind: e.kind, on: on(e.id), source: { kind: "popular", sessions: e.source.sessions, images: e.source.images }, ...(e.size !== undefined ? { size: e.size } : {}) }));
  return { ...recipe, rows: [...rows, ...missing] };
}

/** The recipe with the agents rows ticked as the screen left them. */
export function withAgents(recipe: Recipe, on: ReadonlySet<string>): Recipe {
  return withTicks(recipe, "agent", CATALOG_AGENTS, id => on.has(id));
}

/** The recipe with the tools rows ticked as the list left them; a floor row stays on, since the base installs it anyway. */
export function withTools(recipe: Recipe, on: ReadonlySet<string>): Recipe {
  const floor = new Set(CATALOG_TOOLS.filter(e => e.floor).map(e => e.id));
  return withTicks(recipe, "tool", CATALOG_TOOLS, id => floor.has(id) || on.has(id));
}

/** The catalog ids a recipe ticks, agents or tools. */
export const ticked = (recipe: Recipe, kind: RecipeRow["kind"]): Set<string> => new Set(recipe.rows.filter(r => r.kind === kind && r.on).map(r => r.id));

/** The collector's rows the recipe ticks, as the build would take them before anyone answers, and the bytes they upload. */
function rowsFor(manifest: Manifest, recipe: Recipe): { rows: ManifestEntry[]; bytes: number } {
  const applied = applyRecipe(manifest, recipe);
  const { ticks } = defaultAnswers(applied);
  const rows = applied.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true }));
  return { rows, bytes: rows.reduce((n, e) => n + e.bytes, 0) };
}

/** What the recipe costs on the builder's disk: the collector's rows it ticks, sized as the build would size them. */
export function pickEstimate(manifest: Manifest, recipe: Recipe, brew: BrewTable): DiskEstimate {
  const { rows, bytes } = rowsFor(manifest, recipe);
  return estimateDisk(rows, bytes, brew);
}

/** The Disk line, loud in its weight's colour: the one loud element on the screen. */
export function diskFooter(est: DiskEstimate): FooterLine {
  const tone = diskTone(est.total, est.room);
  return { text: `Disk: ${diskLine(est)}`, ...(tone !== undefined ? { tone } : {}) };
}

/** The six agents: a size beside each, ticked when this Mac has it, the detail saying what comes and what installs. */
export function agentItems(recipe: Recipe, manifest: Manifest): SelectItem[] {
  return CATALOG_AGENTS.map(a => {
    const r = rowOf(recipe, a.id);
    const own = manifest.entries.find(e => e.rung === "agents" && agentName(e) === a.id);
    const config = own !== undefined && own.bytes > 0 ? `; its config (${fmtBytes(own.bytes)}) comes along` : "";
    const here = r?.source.kind === "installed" ? `on this Mac${config}` : "not on this Mac; try it on the machine, nothing here changes";
    return {
      id: a.id,
      label: a.name,
      ...(a.size !== undefined ? { hint: fmtBytes(a.size) } : {}),
      detail: [here, a.size !== undefined ? `installs about ${fmtBytes(a.size)} on the machine (measured ${MEASURED_ON})` : "installs on the machine; size not measured yet"],
    };
  });
}

/** The recipe source in words with its counts, for a tool's detail pane. */
function sourceLine(e: ToolEntry, r: RecipeRow | undefined): string {
  switch (r?.source.kind) {
    case "installed":
      return r.source.bin ? "installed on this Mac" : `on this Mac: ${r.source.paths.join(", ")}`;
    case "used":
      return `your agents used it in ${plural(r.source.sessions, "session")} (${plural(r.source.calls, "call")})`;
    default: {
      const images = r?.source.kind === "popular" ? r.source.images : e.source.images;
      return `${images === 0 ? "in no lab image" : `ships in ${plural(images, "lab image")}`}; ${e.defaultOn ? "on by default in the catalog" : "on request"}`;
    }
  }
}

/** The catalog's tools: the floor as bullets under the title, the rest grouped by the source of their tick, a size
 * beside each where the catalog measured one, the detail naming the source with its counts and what the build does. */
export function toolItems(recipe: Recipe, manifest: Manifest): SelectItem[] {
  const here = rowsHere(manifest.entries);
  const items = CATALOG_TOOLS.map((e): SelectItem & { word: SourceWord } => {
    const r = rowOf(recipe, e.id);
    const word = sourceWord(e, r);
    const size = e.size !== undefined ? `about ${fmtBytes(e.size)} on the machine` : "size not measured yet";
    const build = e.floor ? "part of the base on every machine" : here.has(e.id) ? size : `${size}; no row here; installed by its ${e.installRoad.road} road`;
    return {
      id: e.id,
      label: e.name,
      word,
      ...(e.size !== undefined ? { hint: fmtBytes(e.size) } : {}),
      detail: [e.floor ? `${sourceLine(e, r)}; on every machine` : sourceLine(e, r), build],
      ...(e.floor ? { lock: "on" } : { group: word.charAt(0).toUpperCase() + word.slice(1) }),
    };
  });
  return SOURCE_ORDER.flatMap(w => items.filter(i => i.word === w)).map(({ word: _word, ...item }) => item);
}

export interface SignInScreen {
  items: SelectItem[];
  /** The keys rows that start ticked: a copy by default or a saved copy answer. */
  initial: Set<string>;
  /** Every login row's answer once the ticks are known: the machine for the listed sign-ins, copy for a ticked keys
   * row, and for an unticked one the sign-in on the machine when the row has one to run, else nothing. */
  answers(ticks: ReadonlySet<string>): Map<string, LoginChoice>;
}

const KEYS_LINE = "ticked, it is copied to the machine; unticked, ";

/** The agents an MCP row belongs to: a server's own; for the mcp-remote row, every agent with a server here. */
function mcpAgents(e: ManifestEntry, manifest: Manifest): string[] {
  const own = parseMcpId(e.id)?.agent;
  if (own !== undefined) return [own];
  return [...new Set(manifest.entries.flatMap(s => parseMcpId(s.id)?.agent ?? []))];
}

/** An MCP row that carries a secret is shown once an agent it belongs to is ticked. */
function mcpShown(e: ManifestEntry, manifest: Manifest, coming: ReadonlySet<string>): boolean {
  return e.rung === "agents" && e.consent === true && e.id.startsWith(MCP_ID_PREFIX) && mcpAgents(e, manifest).some(a => coming.has(`agents/${a}`));
}

/** The second column of an MCP row: the agent whose config the server sits in, so the row says what travels; the
 * mcp-remote row's is its size. */
function mcpHint(e: ManifestEntry): string | undefined {
  const agent = parseMcpId(e.id)?.agent;
  if (agent !== undefined) return catalogEntry(agent)?.name ?? agent;
  return e.bytes > 0 ? fmtBytes(e.bytes) : undefined;
}

/** The sign-ins the ticked agents and tools bring: a browser or device login is listed to sign in on the machine
 * after the build, with no action here; a key, a keys file or a config with no sign-in is a row to tick for the
 * copy, as is an MCP server that carries a secret, which starts unticked and stays off the machine unticked. A
 * login whose command is not coming, or one locked out, is listed with the reason and brings nothing. */
export function signInItems(manifest: Manifest): SignInScreen {
  const coming = comingRows(manifest);
  const shown = manifest.entries.filter(e => (e.rung === "logins" && loginShown(e, manifest, coming)) || mcpShown(e, manifest, coming));
  const items: SelectItem[] = [];
  const initial = new Set<string>();
  const fixed = new Map<string, LoginChoice>();
  const unticked = new Map<string, LoginChoice>();
  for (const e of shown) {
    if (e.rung !== "logins") {
      if (!isTickable(e)) {
        items.push({ id: e.id, label: e.label, detail: [e.detail ?? "", e.reason ?? ""], lock: "off" });
        fixed.set(e.id, "skip");
        continue;
      }
      unticked.set(e.id, "skip");
      if (initialChoice(e) === "copy") initial.add(e.id);
      const hint = mcpHint(e);
      items.push({
        id: e.id,
        label: e.label,
        ...(hint !== undefined ? { hint } : {}),
        detail: [e.paths.length > 0 ? e.paths.join(", ") : "defined in the agent's config", e.detail ?? "", `${KEYS_LINE}not copied; the server stays off the machine`],
      });
      continue;
    }
    const s = signInFor(agentName(e));
    const where = e.paths.length > 0 ? e.paths.join(", ") : "nothing to copy";
    if (!isTickable(e)) {
      items.push({ id: e.id, label: e.label, detail: [where, e.reason ?? ""], lock: "off" });
      fixed.set(e.id, "skip");
      continue;
    }
    const tool = loginTool(e, manifest, coming);
    if (tool !== undefined && !tool.coming) {
      items.push({ id: e.id, label: e.label, hint: `${tool.bin} not coming`, detail: [where, tool.why ?? ""], lock: "off" });
      fixed.set(e.id, "skip");
      continue;
    }
    const choice = initialChoice(e);
    if (hasLogin(s) && choice === "machine") {
      items.push({ id: e.id, label: e.label, hint: s.login, detail: [], lock: "on" });
      fixed.set(e.id, "machine");
      continue;
    }
    const otherwise: LoginChoice = hasLogin(s) ? "machine" : "skip";
    unticked.set(e.id, otherwise);
    if (choice === "copy") initial.add(e.id);
    const why = e.detail ?? (s.kind !== "shell" ? s.note : undefined) ?? "";
    items.push({
      id: e.id,
      label: e.label,
      ...(e.bytes > 0 ? { hint: fmtBytes(e.bytes) } : {}),
      detail: [where, why, `${KEYS_LINE}${hasLogin(s) ? `you sign in there after the build (${s.login})` : "it stays here"}`],
    });
  }
  return {
    items,
    initial,
    answers: ticks => new Map([...fixed, ...[...unticked].map(([id, otherwise]): [string, LoginChoice] => [id, ticks.has(id) ? "copy" : otherwise])]),
  };
}

// --- the summary screen ------------------------------------------------------

type NeedAnswer = "next" | "adjust" | "back";
const EDGE = 4;
const NEED_KEYS: readonly HelpKey[] = [{ key: "a", does: "adjust" }, { key: "enter", does: "next" }, { key: "esc", does: "back" }];

interface NeedOptions {
  counter: string;
  line: string;
  disk: FooterLine;
  input?: Readable;
  output?: Writable;
}

/** One line of counts, the Disk line loud under it, and three keys: a opens the row list, enter goes on, esc back. */
class NeedPrompt extends Prompt<NeedAnswer> {
  back = false;

  constructor(private readonly o: NeedOptions) {
    super({ render: () => this.frame(), ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}) }, false);
    this.value = "next";
    this.on("key", (char, key) => {
      if (key.name === "escape") this.back = true;
      if (char === "a" && this.state !== "submit" && this.state !== "cancel") {
        this.value = "adjust";
        this.state = "submit";
      }
    });
  }

  private frame(): string {
    const width = widthOf(this.o.output);
    const counter = `${GUTTER}${dim(this.o.counter)}`;
    if (this.state === "submit" || (this.state === "cancel" && this.back)) {
      return `${styleText("green", S_STEP_SUBMIT)}  ${NEED_TITLE}${counter}\n${dim(S_BAR)}  ${dim(this.back ? "back" : this.o.line)}`;
    }
    if (this.state === "cancel") return `${styleText("red", S_STEP_CANCEL)}  ${NEED_TITLE}${counter}\n${dim(S_BAR)}  ${dim("cancelled")}`;
    const bar = dim(S_BAR_FOCUS);
    const disk = this.o.disk;
    // The Disk line wraps under its own label, every row of it in the tone: the one loud element on the screen.
    const loud = (l: string): string => (typeof disk === "string" ? dim(l) : disk.tone === undefined ? l : styleText(disk.tone, l));
    return [
      `${styleText("cyan", S_STEP_ACTIVE)}  ${styleText("cyan", NEED_TITLE)}${counter}`,
      ...wrap(this.o.line, width - EDGE).map(l => `${bar}  ${l}`),
      ...wrap(typeof disk === "string" ? disk : disk.text, width - EDGE, " ".repeat("Disk: ".length)).map(l => `${bar}  ${loud(l)}`),
      `${dim(S_BAR_FOCUS_END)}  ${helpLine(NEED_KEYS, colourDepth(isTTY(this.o.output)))}`,
    ].join("\n");
  }
}

export async function needScreen(o: NeedOptions): Promise<NeedAnswer | "cancel"> {
  const prompt = new NeedPrompt(o);
  const result = await prompt.prompt();
  if (isCancel(result)) return prompt.back ? "back" : "cancel";
  return result === "adjust" ? "adjust" : "next";
}

// --- the flow ------------------------------------------------------------------

export interface PickOptions {
  /** The collector's rows, every catalog agent among them. */
  manifest: Manifest;
  recipe: Recipe;
  brew: BrewTable;
  /** The first screen: the agents, or the sign-ins alone when a recipe file already decided the rest. */
  from: "agents" | "logins";
  input: Readable;
  output: Writable;
}

export interface Picked {
  recipe: Recipe;
  /** Every shown login row's answer. */
  logins: Map<string, LoginChoice>;
}

type Screen = "agents" | "need" | "logins";

/** The screens in order, esc stepping back one; the recipe carries the ticks between them. */
export async function pickScreens(o: PickOptions): Promise<Picked | "cancel"> {
  const screens: readonly Screen[] = o.from === "agents" ? ["agents", "need", "logins"] : ["logins"];
  let recipe = o.recipe;
  let logins = new Map<string, LoginChoice>();
  const streams = { input: o.input, output: o.output };
  let i = 0;
  while (i < screens.length) {
    const counter = `${i + 1}/${screens.length}`;
    const screen = screens[i]!;
    switch (screen) {
      case "agents": {
        const r = await rungSelect({ title: AGENTS_TITLE, counter, items: agentItems(recipe, o.manifest), initial: ticked(recipe, "agent"), ...streams });
        if (r.kind === "cancel") return "cancel";
        recipe = withAgents(recipe, r.ticks);
        if (r.kind === "next") i += 1;
        break;
      }
      case "need": {
        const answer = await needScreen({ counter, line: needLine(recipe), disk: diskFooter(pickEstimate(o.manifest, recipe, o.brew)), ...streams });
        if (answer === "cancel") return "cancel";
        if (answer === "back") {
          i -= 1;
          break;
        }
        if (answer === "next") {
          i += 1;
          break;
        }
        const r = await rungSelect({
          title: NEED_TITLE,
          counter,
          items: toolItems(recipe, o.manifest),
          initial: ticked(recipe, "tool"),
          lockedWord: BASE_WORD,
          footer: ticks => [diskFooter(pickEstimate(o.manifest, withTools(recipe, ticks), o.brew))],
          ...streams,
        });
        if (r.kind === "cancel") return "cancel";
        recipe = withTools(recipe, r.ticks);
        break;
      }
      case "logins": {
        const s = signInItems(applyRecipe(o.manifest, recipe));
        const r = await rungSelect({ title: SIGN_INS_TITLE, counter, items: s.items, initial: s.initial, detailLines: 3, lockedWord: MACHINE_WORD, ...streams });
        if (r.kind === "cancel") return "cancel";
        logins = s.answers(r.ticks);
        if (r.kind === "back") {
          i = Math.max(0, i - 1);
          break;
        }
        i += 1;
        break;
      }
      default: {
        const _exhaustive: never = screen;
        return _exhaustive;
      }
    }
  }
  return { recipe, logins };
}
