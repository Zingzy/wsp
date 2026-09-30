// SPDX-License-Identifier: AGPL-3.0-only
// The two usage ledgers, which are never added together: what an agent account
// may still use (its plan's windows, as the agent itself printed them in a turn
// wsp ran) and what was used (tokens per turn, filed by day, priced off one
// table). Also the rate table off LiteLLM's price file and the words a row reads.
import { z } from "zod";
import { fmtCost, LIST_PRICE_WORD } from "./format.js";

/** The windows a plan counts use over, as wsp names them: an agent's five-hour window is the session, its seven-day
 * the week, a per-model week its own kind, and anything longer the month. */
export const LIMIT_KINDS = ["session", "week", "week_opus", "week_sonnet", "month", "overage"] as const;
export const LimitKind = z.enum(LIMIT_KINDS);
export type LimitKind = z.infer<typeof LimitKind>;

/** One window of a plan: how much of it is used, 0 to 100 and past 100 where the agent ran over, and when it
 * starts again, ms epoch, where the agent said. */
export const LimitWindow = z.object({ kind: LimitKind, usedPercent: z.number(), resetsAt: z.number().optional() });
export type LimitWindow = z.infer<typeof LimitWindow>;

export const LimitStatus = z.enum(["ok", "warning", "reached"]);
export type LimitStatus = z.infer<typeof LimitStatus>;

/** A plan's limits as a harness printed them during a turn. account is the harness's own name for the sign-in
 * where it gives one; keyed is a sign-in by API key, which has no plan window at all. */
export const HarnessLimit = z.object({
  windows: z.array(LimitWindow),
  plan: z.string().optional(),
  status: LimitStatus.optional(),
  account: z.object({ id: z.string(), label: z.string().optional() }).optional(),
  keyed: z.boolean().optional(),
});
export type HarnessLimit = z.infer<typeof HarnessLimit>;

/** The agents whose harness prints its plan's limits in a turn; every other agent's row reads limit not available. */
export const LIMIT_AGENTS: readonly string[] = ["claude", "codex"];

/** A window's length in minutes as a limit kind: five hours is the session and seven days the week. */
export function limitKindOfMinutes(minutes: number): LimitKind {
  if (minutes <= 300) return "session";
  if (minutes <= 10_080) return "week";
  return "month";
}

/** An account's limits as the host keeps them: the last reading any computer's turn gave, and every computer whose
 * turns ran on it. */
export const AccountLimit = z.object({
  key: z.string(),
  agent: z.string(),
  label: z.string(),
  plan: z.string().optional(),
  windows: z.array(LimitWindow),
  status: LimitStatus.optional(),
  keyed: z.boolean().optional(),
  readAt: z.number(),
  computers: z.array(z.string()),
});
export type AccountLimit = z.infer<typeof AccountLimit>;

/** Why an account row carries no windows: its agent reports none, it signs in with a key, or no turn has run on it. */
export const AccountNote = z.enum(["limit not available", "no plan limit: signed in with a key", "not read yet: runs a thread first"]);
export type AccountNote = z.infer<typeof AccountNote>;

/** One sign-in as the Usage page lists it: the same account on three computers is one row naming all three. */
export const AccountRow = z.object({
  key: z.string(),
  agent: z.string(),
  label: z.string(),
  computers: z.array(z.string()),
  plan: z.string().optional(),
  windows: z.array(LimitWindow).optional(),
  status: LimitStatus.optional(),
  readAt: z.number().optional(),
  note: AccountNote.optional(),
});
export type AccountRow = z.infer<typeof AccountRow>;

export const AccountsAnswer = z.object({ accounts: z.array(AccountRow) });
export type AccountsAnswer = z.infer<typeof AccountsAnswer>;

export const USAGE_RANGES = ["day", "week", "month"] as const;
export const UsageRange = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof UsageRange>;

export const USAGE_SPLITS = ["agent", "account", "computer", "project"] as const;
export const UsageSplit = z.enum(USAGE_SPLITS);
export type UsageSplit = z.infer<typeof UsageSplit>;

/** The days a range reaches back over, today included. */
export const RANGE_DAYS: Record<UsageRange, number> = { day: 1, week: 7, month: 30 };

/** The step a computer's chart folds its readings into for each range, so an answer is a few hundred points. */
export const READINGS_STEP_MS: Record<UsageRange, number> = { day: 5 * 60_000, week: 30 * 60_000, month: 2 * 3_600_000 };

/** What a usage row is filed under: the day and hour in this computer's zone, and the four splits and the model. */
export const UsageKey = z.object({
  day: z.string(),
  hour: z.number().int(),
  agent: z.string(),
  account: z.string(),
  computer: z.string(),
  project: z.string(),
  model: z.string(),
});
export type UsageKey = z.infer<typeof UsageKey>;

export const UsageTokens = z.object({ input: z.number(), output: z.number(), cached: z.number(), cacheWrite: z.number(), reasoning: z.number() });
export type UsageTokens = z.infer<typeof UsageTokens>;

/** One key's use: its turns and tokens, the cost the harness itself reported where it did, and where it was read:
 * a turn wsp ran, or a harness's own log of work done outside wsp on this computer. */
export const UsageRow = UsageKey.extend({
  turns: z.number().int(),
  tokens: UsageTokens,
  costReported: z.number().optional(),
  source: z.enum(["wsp", "log"]),
});
export type UsageRow = z.infer<typeof UsageRow>;

/** A day's rows, one document per day, with the harness sessions wsp's own turns were filed under that day: what a
 * read of the logs leaves out, so no turn counts twice. */
export const UsageDay = z.object({ day: z.string(), rows: z.array(UsageRow), sessions: z.array(z.string()).optional() });
export type UsageDay = z.infer<typeof UsageDay>;

/** One split value's use over a range. costList is the rate table's figure for the tokens no harness put a cost on,
 * and priced is false where some of them have no entry in it. outside marks the rows read from the logs. */
export const UsedRow = z.object({
  key: z.string(),
  label: z.string(),
  tokens: UsageTokens.pick({ input: true, output: true, cached: true }),
  costReported: z.number().optional(),
  costList: z.number().optional(),
  priced: z.boolean(),
  outside: z.boolean().optional(),
});
export type UsedRow = z.infer<typeof UsedRow>;

export const UsedAnswer = z.object({
  range: UsageRange,
  split: UsageSplit,
  rows: z.array(UsedRow),
  /** Tokens, in and out, per hour for a day's range and per day otherwise, oldest first; a step with none reads 0. */
  series: z.array(z.object({ t: z.number(), tokens: z.number() })),
  since: z.number(),
  until: z.number(),
});
export type UsedAnswer = z.infer<typeof UsedAnswer>;

/** Every sentence a usage row may carry. */
export const USAGE_WORDS = {
  notPriced: "not priced",
  listPrice: LIST_PRICE_WORD,
  outsideWsp: "outside wsp",
  noLimit: "limit not available",
  keyed: "no plan limit: signed in with a key",
  unread: "not read yet: runs a thread first",
  reached: "limit reached",
  noReadings: "No readings in this range",
  noUse: "Nothing used in this range",
} as const;

/** How long a price table is used before the host reads LiteLLM's file again. */
export const PRICES_TTL_MS = 24 * 3_600_000;
export const PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** A model's per-token prices in dollars. cacheRead and cacheWrite are absent where the table names none. */
export interface Rate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  provider?: string;
}
export type RateTable = Record<string, Rate>;

const price = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The table off LiteLLM's price file: each model's four base per-token prices. The long-context, batch, flex and
 * priority twins beside them are not what a turn pays and are left out, and so is any entry with no input or output
 * price, the file's own description of its fields among them. */
export function parseRateTable(document: unknown): RateTable {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return {};
  const table: RateTable = {};
  for (const [model, raw] of Object.entries(document)) {
    if (typeof raw !== "object" || raw === null || model === "sample_spec") continue;
    const entry = raw as Record<string, unknown>;
    const input = price(entry["input_cost_per_token"]);
    const output = price(entry["output_cost_per_token"]);
    if (input === undefined || output === undefined) continue;
    const cacheRead = price(entry["cache_read_input_token_cost"]);
    const cacheWrite = price(entry["cache_creation_input_token_cost"]);
    const provider = typeof entry["litellm_provider"] === "string" ? entry["litellm_provider"] : undefined;
    table[model] = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), ...(provider !== undefined ? { provider } : {}) };
  }
  return table;
}

/** A model's entry as a harness names it: as it is, without a provider in front, or without a date after it. */
function rateOf(model: string, table: RateTable): Rate | undefined {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return table[model] ?? table[bare] ?? table[bare.replace(/-\d{8}$/, "")];
}

/** The list price of a turn's tokens, dollars, or nothing where the table has no entry for its model. input counts
 * every token the model read, the cached and the written part included, so each part is priced at its own rate. */
export function priceOf(model: string, tokens: { input: number; output: number; cached?: number; cacheWrite?: number }, table: RateTable): number | undefined {
  const rate = rateOf(model, table);
  if (rate === undefined) return undefined;
  const cached = tokens.cached ?? 0;
  const written = tokens.cacheWrite ?? 0;
  const fresh = Math.max(0, tokens.input - cached - written);
  return fresh * rate.input + cached * (rate.cacheRead ?? rate.input) + written * (rate.cacheWrite ?? rate.input) + tokens.output * rate.output;
}

/** The calendar day an instant falls on in a zone, YYYY-MM-DD; this computer's own zone where none is named. */
export function dayKeyOf(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone !== undefined ? { timeZone } : {}) }).formatToParts(at);
  const part = (type: string): string => parts.find(p => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The hour of the day an instant falls on in a zone, 0 to 23. */
export function hourOf(at: number, timeZone?: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", ...(timeZone !== undefined ? { timeZone } : {}) }).format(at);
  return Number(hour) % 24;
}

/** When a window starts again, as a row's quiet word: minutes under an hour, hours under a day, then the weekday. */
export function resetsWord(resetsAt: number, now: number, timeZone?: string): string {
  const left = resetsAt - now;
  if (left <= 0) return "reset";
  if (left < 3_600_000) return `resets in ${Math.max(1, Math.round(left / 60_000))} min`;
  if (left < 86_400_000) return `resets in ${Math.floor(left / 3_600_000)} h`;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", ...(timeZone !== undefined ? { timeZone } : {}) }).format(resetsAt);
  return `resets on ${weekday}`;
}

/** When a limit was last read, as the row's quiet word: the time today, else the weekday and time. */
export function asOfWord(readAt: number, now: number, timeZone?: string): string {
  const zone = timeZone !== undefined ? { timeZone } : {};
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...zone }).format(readAt);
  if (dayKeyOf(readAt, timeZone) === dayKeyOf(now, timeZone)) return `as of ${time}`;
  return `as of ${new Intl.DateTimeFormat("en-US", { weekday: "short", ...zone }).format(readAt)} ${time}`;
}

/** A used row's price as a row reads it: the figure, with list price where any of it came off the table, or not
 * priced where none could be; nothing where no turn carried a price at all. */
export function usedPrice(row: Pick<UsedRow, "costReported" | "costList" | "priced">): { figure?: string; word?: string } {
  if (row.costReported === undefined && row.costList === undefined) return row.priced ? {} : { word: USAGE_WORDS.notPriced };
  const figure = fmtCost((row.costReported ?? 0) + (row.costList ?? 0));
  return row.costList !== undefined && row.costList > 0 ? { figure, word: USAGE_WORDS.listPrice } : { figure };
}

/** A window as a row's cell: how much of it is used and when it starts again. */
export function windowCell(w: LimitWindow, now: number, timeZone?: string): string {
  const used = `${Math.round(w.usedPercent)}%`;
  return w.resetsAt === undefined ? used : `${used} ${resetsWord(w.resetsAt, now, timeZone)}`;
}

/** An account row's state cell: limit reached where the agent said so, else the note that says why it has no windows. */
export function accountState(row: Pick<AccountRow, "status" | "note">): string {
  return row.status === "reached" ? USAGE_WORDS.reached : (row.note ?? "");
}
