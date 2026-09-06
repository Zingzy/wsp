// SPDX-License-Identifier: AGPL-3.0-only
// The recipe as one table: a row per catalog agent and tool with its tick,
// why it has that tick, and what it costs on the machine. The rule for the
// words and for what counts as a heavy row lives here alone, so the recipe
// verb, the MCP tool and the wizard's What they need screen say the same
// thing about the same recipe.
import { agentName, hasLogin, keysIdOf, loginIdOf, loginRow, signsInByDefault } from "@wsp/catalog";
import type { CommandCount } from "@wsp/collect";
import { RecipeTick, fmtBytes, type Recipe, type RecipeRow, type RecipeSource } from "@wsp/protocol";
import { z } from "zod";
import { table } from "./init-layout.js";
import { signInFor, signInWords } from "./signin-table.js";

/** A row this big is one the person is asked about before it is built: it is a real part of the wait and the disk. */
export const HEAVY_BYTES = 300 * 1024 * 1024;

/** How many of the uncatalogued commands the printout shows: enough to see the shape of the person's work. */
export const COMMANDS_SHOWN = 12;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the printout says about a row whose size the catalog never measured. */
export const UNMEASURED = "not measured";

/** Why a row has the tick it has, in the words a person and an agent both read. Under `used` the sources are read
 * used first, so an installed row that reached this far was never used and says so; a recipe that names no rule
 * (the wizard's own) cannot claim that, and its installed rows say only that they are here. */
export function whyLine(source: RecipeSource, tick: RecipeTick | undefined): string {
  switch (source.kind) {
    case "used":
      return `used ${plural(source.calls, "time")} in ${plural(source.sessions, "session")}`;
    case "installed":
      return tick === "used" ? "installed here, never used" : "installed here";
    case "popular":
      return "catalog default";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export const RecipeTableRow = z.object({
  /** The catalog id, the same word `--set` takes. */
  id: z.string(),
  name: z.string(),
  kind: z.enum(["agent", "tool"]),
  on: z.boolean(),
  why: z.string(),
  /** What it adds to the machine, when the catalog measured it. */
  size: z.number().int().nonnegative().optional(),
});
export type RecipeTableRow = z.infer<typeof RecipeTableRow>;

export const RecipeCommand = z.object({ name: z.string(), calls: z.number().int().nonnegative(), sessions: z.number().int().nonnegative() });
export type RecipeCommand = z.infer<typeof RecipeCommand>;

export const RecipeTable = z.object({
  /** Which rule decided the ticks; absent on a recipe that names none, as the wizard's own do. */
  tick: RecipeTick.optional(),
  /** When the recipe was read off this computer, ISO 8601. */
  at: z.string(),
  /** Where the recipe file sits. */
  out: z.string(),
  rows: z.array(RecipeTableRow),
  /** Every ticked row the catalog measured, added up. */
  totalBytes: z.number().int().nonnegative(),
  /** The ticked rows over HEAVY_BYTES, biggest first: the ones to put to the person before the build. */
  heavy: z.array(RecipeTableRow),
  /** The commands the agents ran here that no catalog row carries, most-run first. */
  commands: z.array(RecipeCommand),
});
export type RecipeTable = z.infer<typeof RecipeTable>;

/** A recipe's rows as the table shows them, in catalog order: what a caller with a recipe and no file hands to
 * recipeTableLines (the wizard's What they need screen does exactly this). */
export function recipeTableRows(recipe: Recipe): RecipeTableRow[] {
  const tick = recipe.tick;
  return recipe.rows.map((r: RecipeRow): RecipeTableRow => ({
    id: r.id,
    name: agentName(r.id),
    kind: r.kind,
    on: r.on,
    why: whyLine(r.source, tick),
    ...(r.size !== undefined ? { size: r.size } : {}),
  }));
}

/** The recipe as the table every client shows, with the file it was written to and what it adds up to. */
export function recipeTable(recipe: Recipe, out: string, commands: readonly CommandCount[] = []): RecipeTable {
  const rows = recipeTableRows(recipe);
  const on = rows.filter(r => r.on);
  return {
    ...(recipe.tick !== undefined ? { tick: recipe.tick } : {}),
    at: recipe.at,
    out,
    rows,
    totalBytes: on.reduce((n, r) => n + (r.size ?? 0), 0),
    heavy: on.filter(r => (r.size ?? 0) > HEAVY_BYTES).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)),
    commands: commands.map(c => ({ name: c.name, calls: c.calls, sessions: c.sessions })),
  };
}

/** The table itself: a header and one line per row, columns lined up, no colour. The wizard draws these lines
 * inside its own frame, so nothing here knows about a terminal. */
export function recipeTableLines(rows: readonly RecipeTableRow[]): string[] {
  return table(
    [["id", "on", "why", "size"], ...rows.map(r => [r.id, r.on ? "on" : "off", r.why, r.size !== undefined ? fmtBytes(r.size) : UNMEASURED])],
    ["left", "left", "left", "right"],
  );
}

/** The last line under the table: what the ticked rows add up to, how many the catalog never measured (so the
 * total is a floor, not the whole), and how many are worth putting to the person. */
export function recipeTotalLine(t: RecipeTable): string {
  const on = t.rows.filter(r => r.on);
  const unmeasured = on.filter(r => r.size === undefined).length;
  const of = unmeasured > 0 ? `${fmtBytes(t.totalBytes)} measured and ${plural(unmeasured, "row")} not` : fmtBytes(t.totalBytes);
  return `${plural(on.length, "row")} on, ${of}; ${plural(t.heavy.length, "row")} over ${fmtBytes(HEAVY_BYTES)}.`;
}

export const COMMANDS_TITLE = "Commands your agents ran that the catalog does not carry:";

/** The second table: what this person works with that no catalog row installs, most-run first. */
export function commandTableLines(commands: readonly RecipeCommand[], shown = COMMANDS_SHOWN): string[] {
  if (commands.length === 0) return [COMMANDS_TITLE, "  none"];
  const rows = commands.slice(0, shown);
  return [
    COMMANDS_TITLE,
    ...table([["command", "calls", "sessions"], ...rows.map(c => [c.name, String(c.calls), String(c.sessions)])], ["left", "right", "right"]).map(l => `  ${l}`),
    ...(commands.length > rows.length ? [`  and ${commands.length - rows.length} more`] : []),
  ];
}

/** Everything the recipe verb and the MCP tool print: the table, its total line, then the commands table. */
export function recipePrintout(t: RecipeTable): string[] {
  return [...recipeTableLines(t.rows), recipeTotalLine(t), "", ...commandTableLines(t.commands)];
}

// --- the scan: every option, with what an agent should do about each ------------------------------------------

/** The heading over the tools this computer has that no catalog row carries, grouped by what installed them. */
export const ALSO_HERE_TITLE = "Also on this Mac";
/** What that section says while nothing on this computer scans for those tools. */
export const NO_SCANNER = "no scanner yet";

export const RecipeAdvice = z.object({
  /** What to do without asking: `on` or `off` for a tick row, one of the sign-in words for a sign-in row. */
  value: z.string(),
  /** Why, in one line, so an agent can put the few rows worth a question and apply the rest. */
  why: z.string(),
});
export type RecipeAdvice = z.infer<typeof RecipeAdvice>;

export const RecipeScanRow = RecipeTableRow.extend({ recommended: RecipeAdvice });
export type RecipeScanRow = z.infer<typeof RecipeScanRow>;

export const RecipeScanSignIn = z.object({
  id: z.string(),
  name: z.string(),
  /** What signing in there runs, or why there is nothing to run. */
  signIn: z.string(),
  recommended: RecipeAdvice,
});
export type RecipeScanSignIn = z.infer<typeof RecipeScanSignIn>;

export const RecipeScanAlso = z.object({
  /** False while nothing here looks for tools outside the catalog, so a reader tells empty from unscanned. */
  scanned: z.boolean(),
  managers: z.array(z.object({ manager: z.string(), rows: z.array(z.object({ id: z.string(), install: z.string(), size: z.number().int().nonnegative().optional() })) })),
});
export type RecipeScanAlso = z.infer<typeof RecipeScanAlso>;

export const RecipeScan = z.object({
  tick: RecipeTick,
  at: z.string(),
  agents: z.array(RecipeScanRow),
  tools: z.array(RecipeScanRow),
  totalBytes: z.number().int().nonnegative(),
  heavy: z.array(RecipeScanRow),
  alsoHere: RecipeScanAlso,
  commands: z.array(RecipeCommand),
  signIns: z.array(RecipeScanSignIn),
});
export type RecipeScan = z.infer<typeof RecipeScan>;

/** What to do with a row without asking, and why: the rule's own tick, with the one thing that makes a row worth a
 * question said in the same line. Nothing else here is a delta. */
export function tickAdvice(row: RecipeTableRow): RecipeAdvice {
  const size = row.size;
  const heavy = row.on && size !== undefined && size > HEAVY_BYTES;
  return { value: row.on ? "on" : "off", why: heavy ? `${row.why}; ${fmtBytes(size)} on the machine, worth a question` : row.why };
}

/** What to do with a row's sign-in without asking: key files beside a login come first, since key brings them and
 * still leaves the login itself to run on the machine, so it gets what either other word gets alone; then a browser
 * or device login runs on the machine, anything else that exists only here travels by copy, and the rest is skipped. */
export function signInAdvice(id: string): RecipeAdvice {
  const s = signInFor(loginIdOf(id));
  if (loginRow(keysIdOf(id)) !== undefined) return { value: "key", why: "no sign-in there produces its keys, so they travel and it still signs in on the machine" };
  if (signsInByDefault(s)) return { value: "machine", why: "a browser sign-in the machine finishes; nothing of it is copied" };
  if (hasLogin(s) || (s.kind !== "shell" && s.sources.length > 0)) return { value: "copy", why: "nothing there produces it, so what is here travels" };
  return { value: "skip", why: "nothing to sign in to and nothing here to bring" };
}

/** Every option this computer offers, read once: the agents and tools with the rule's tick and what to do about
 * each, the tools outside the catalog (nothing scans for them yet), the commands the catalog does not carry, and
 * the sign-in each ticked row brings. Nothing is written. */
export function recipeScan(recipe: Recipe, commands: readonly CommandCount[] = []): RecipeScan {
  const rows = recipeTableRows(recipe).map((r): RecipeScanRow => ({ ...r, recommended: tickAdvice(r) }));
  const on = rows.filter(r => r.on);
  return {
    tick: recipe.tick ?? "used",
    at: recipe.at,
    agents: rows.filter(r => r.kind === "agent"),
    tools: rows.filter(r => r.kind === "tool"),
    totalBytes: on.reduce((n, r) => n + (r.size ?? 0), 0),
    heavy: on.filter(r => (r.size ?? 0) > HEAVY_BYTES).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)),
    alsoHere: { scanned: false, managers: [] },
    commands: commands.map(c => ({ name: c.name, calls: c.calls, sessions: c.sessions })),
    signIns: on.flatMap((r): RecipeScanSignIn[] => {
      const s = signInFor(loginIdOf(r.id));
      if (s.kind === "shell") return [];
      return [{ id: r.id, name: r.name, signIn: signInWords(s), recommended: signInAdvice(r.id) }];
    }),
  };
}

/** The scan rows with the recommendation beside them: the table's own columns plus what to do and why. */
export function scanTableLines(rows: readonly RecipeScanRow[]): string[] {
  return table(
    [
      ["id", "on", "why", "size", "do"],
      ...rows.map(r => [r.id, r.on ? "on" : "off", r.recommended.why, r.size !== undefined ? fmtBytes(r.size) : UNMEASURED, r.recommended.value]),
    ],
    ["left", "left", "left", "right", "left"],
  );
}

export const SIGN_INS_TITLE = "Sign-ins the ticked rows bring:";

export function signInTableLines(rows: readonly RecipeScanSignIn[]): string[] {
  if (rows.length === 0) return [SIGN_INS_TITLE, "  none"];
  return [SIGN_INS_TITLE, ...table([["id", "sign in", "do"], ...rows.map(r => [r.id, r.signIn, r.recommended.value])]).map(l => `  ${l}`)];
}

/** What the section on tools outside the catalog says: the rows by manager, or that nothing looked for them. */
export function alsoHereLines(also: RecipeScanAlso): string[] {
  if (!also.scanned) return [ALSO_HERE_TITLE, `  ${NO_SCANNER}`];
  if (also.managers.length === 0) return [ALSO_HERE_TITLE, "  none"];
  return [
    ALSO_HERE_TITLE,
    ...also.managers.flatMap(m => [`  ${m.manager}`, ...table(m.rows.map(r => [r.id, r.install, r.size !== undefined ? fmtBytes(r.size) : UNMEASURED]), ["left", "left", "right"]).map(l => `    ${l}`)]),
  ];
}

/** The whole scan on the terminal: agents, tools, the tools outside the catalog, the commands, the sign-ins. */
export function scanPrintout(s: RecipeScan): string[] {
  const unmeasured = [...s.agents, ...s.tools].filter(r => r.on && r.size === undefined).length;
  const of = unmeasured > 0 ? `${fmtBytes(s.totalBytes)} measured and ${plural(unmeasured, "row")} not` : fmtBytes(s.totalBytes);
  return [
    "Agents",
    ...scanTableLines(s.agents).map(l => `  ${l}`),
    "",
    "Tools",
    ...scanTableLines(s.tools).map(l => `  ${l}`),
    `${plural(s.agents.filter(r => r.on).length + s.tools.filter(r => r.on).length, "row")} on, ${of}; ${plural(s.heavy.length, "row")} over ${fmtBytes(HEAVY_BYTES)}.`,
    "",
    ...alsoHereLines(s.alsoHere),
    "",
    ...commandTableLines(s.commands),
    "",
    ...signInTableLines(s.signIns),
  ];
}
