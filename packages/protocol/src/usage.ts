// SPDX-License-Identifier: AGPL-3.0-only
// The two usage ledgers, which are never added together: what an agent account
// may still use (its plan's windows, as the agent itself printed them in a turn
// wsp ran) and what was used (tokens per turn, filed by day, priced off one
// table). Also the rate table off LiteLLM's price file and the words a row reads.
import { z } from "zod";
import { fmtCost, fmtTokens, LIST_PRICE_WORD } from "./format.js";

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

export const RESET_CREDIT_STATUSES = ["available", "redeeming", "redeemed", "unknown"] as const;

/** One reset a plan has banked, as its agent lists it: an id the agent spends it by, whether it can still be spent,
 * and when it lapses, ms epoch, where it does. */
export const ResetCredit = z.object({ id: z.string(), status: z.enum(RESET_CREDIT_STATUSES), expiresAt: z.number().optional() });
export type ResetCredit = z.infer<typeof ResetCredit>;

/** The resets a plan has banked: how many can be spent, and each one where the agent was asked for them in full,
 * which it may cut short of the count. */
export const BankedResets = z.object({ count: z.number().int().nonnegative(), credits: z.array(ResetCredit).optional() });
export type BankedResets = z.infer<typeof BankedResets>;

/** A plan's limits as a harness printed them during a turn. account is the harness's own name for the sign-in
 * where it gives one; keyed is a sign-in by API key, which has no plan window at all. credits is absent on a reading
 * that did not ask for them, which leaves the last one standing. */
export const HarnessLimit = z.object({
  windows: z.array(LimitWindow),
  plan: z.string().optional(),
  status: LimitStatus.optional(),
  account: z.object({ id: z.string(), label: z.string().optional() }).optional(),
  keyed: z.boolean().optional(),
  credits: BankedResets.optional(),
});
export type HarnessLimit = z.infer<typeof HarnessLimit>;

/** A window's length in minutes as a limit kind: five hours is the session and seven days the week. */
export function limitKindOfMinutes(minutes: number): LimitKind {
  if (minutes <= 300) return "session";
  if (minutes <= 10_080) return "week";
  return "month";
}

/** How a turn reached its account: one the harness named, the vault's token or key handed to every computer, or
 * the login a computer keeps of its own. */
export const AccountRoad = z.enum(["named", "vault", "own"]);
export type AccountRoad = z.infer<typeof AccountRoad>;

/** An account's limits as the host keeps them: the last reading any computer's turn gave, and every computer whose
 * turns ran on it. */
export const AccountLimit = z.object({
  key: z.string(),
  agent: z.string(),
  label: z.string(),
  road: AccountRoad.optional(),
  plan: z.string().optional(),
  windows: z.array(LimitWindow),
  status: LimitStatus.optional(),
  keyed: z.boolean().optional(),
  readAt: z.number(),
  computers: z.array(z.string()),
  /** The banked resets as last read, when, and when each was last read in full, where they ever were. */
  credits: BankedResets.extend({ readAt: z.number(), detailAt: z.number().optional() }).optional(),
});
export type AccountLimit = z.infer<typeof AccountLimit>;

/** Every sentence a usage row may carry. */
export const USAGE_WORDS = {
  notPriced: "not priced",
  listPrice: LIST_PRICE_WORD,
  noLimit: "reports no plan limit",
  keyed: "pays per token, no plan limit",
  unread: "not read yet: shows after its next turn",
  reached: "limit reached",
  noUse: "Nothing used in this range",
} as const;

/** Why an account row carries no windows: its agent reports none, it signs in with a key, or no turn has run on it. */
export const AccountNote = z.enum([USAGE_WORDS.noLimit, USAGE_WORDS.keyed, USAGE_WORDS.unread]);
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
  /** What the account's running threads are drawing on it now: tokens a minute over the last fifteen minutes, and how
   * many threads. Absent where nothing ran on it in that time. */
  burn: z.object({ tokensPerMinute: z.number(), threads: z.number().int() }).optional(),
  /** The address a named account signed in as, which a person may name it by. */
  address: z.string().optional(),
  /** The resets the plan has banked, with the soonest one that can still be spent lapses. */
  credits: BankedResets.extend({ nextExpiresAt: z.number().optional(), readAt: z.number(), detailAt: z.number().optional() }).optional(),
});
export type AccountRow = z.infer<typeof AccountRow>;

export const AccountsAnswer = z.object({ accounts: z.array(AccountRow) });
export type AccountsAnswer = z.infer<typeof AccountsAnswer>;

/** What a press to spend a banked reset came to: the agent's four answers, a count that fell since an earlier press
 * nobody answered, which spends nothing more, or an answer this code does not know, which is never read as a reset. */
export const RESET_OUTCOMES = ["reset", "nothingToReset", "noCredit", "alreadyRedeemed", "earlier", "unknown"] as const;
export const ResetOutcome = z.enum(RESET_OUTCOMES);
export type ResetOutcome = z.infer<typeof ResetOutcome>;

/** The outcome, the sentence that says it, and the account's row as the read after it left it. */
export const ResetAnswer = z.object({ outcome: ResetOutcome, said: z.string(), account: AccountRow.optional() });
export type ResetAnswer = z.infer<typeof ResetAnswer>;

/** The account a reset sentence is about: its label, and the computer it runs on where the label does not say. */
export const resetWho = (o: { label: string; own: boolean; computer: string }): string => (o.own ? o.label : `${o.label} on ${o.computer}`);

/** Every sentence a reset may end in, by what it came to. */
export const RESET_WORDS = {
  reset: (who: string, left?: number) => `Reset used: ${who}'s windows start again now${left === undefined ? "" : `, ${left} left`}`,
  nothingToReset: (who: string) => `No window of ${who} is in use right now, so the credit was kept`,
  noCredit: (who: string) => `No reset banked on ${who}`,
  alreadyRedeemed: (who: string) => `That reset of ${who} was already used`,
  earlier: (who: string, left: number) =>
    `The count on ${who} fell since the earlier press: it may have gone through, or a reset expired or was used elsewhere. Nothing more was spent; ${left} left.`,
  unknown: (agent: string, outcome: string, who: string) => `${agent} answered ${outcome} for ${who}; the account was read again`,
} as const;

/** The one question a spend asks first, in the command line and the app alike. */
export function resetQuestion(who: string, count: number | undefined): string {
  const which = count === undefined ? "a reset" : count === 1 ? "the one reset" : `one of the ${count} resets`;
  return `Use ${which} banked on ${who}? Its five-hour and weekly windows start again now. There is no undo.`;
}

export const resetKeyedLine = (label: string): string => `${label} pays per token; an API key has no reset to use`;
export const resetSilentLine = (agent: string, computer: string): string => `${agent} on ${computer} did not answer; the same request goes again on the next press`;
export const resetUnreadLine = (agent: string, computer: string, label: string): string => `${agent} on ${computer} did not read ${label}'s limits; nothing was spent`;
export const resetMismatchLine = (agent: string, computer: string, other: string, label: string): string => `${agent} on ${computer} is now signed in as ${other}, not ${label}; nothing was spent`;
export const resetRefusedLine = (agent: string, computer: string, label: string, said: string): string => `${agent} on ${computer} refused the reset of ${label}: ${said}`;
export const resetProviderOnlyLine = (label: string, provider: string, agent: string): string => `${label} lives only on ${provider} machines; sign ${agent} in on a computer of yours`;
export const resetSignedOutLine = (label: string, agent: string): string => `${label} is signed in on none of your computers now; sign ${agent} in on one of them`;
export const resetNotOnLine = (label: string, computer: string, on: readonly string[]): string => `${label} is not signed in on ${computer}; it is on ${listWords(on)}`;
export const resetNoLoginsLine = (computer: string, agent: string): string =>
  `${computer} has not said where it keeps its logins, so ${agent}'s there cannot be reached; wsp add ${computer} --update puts a newer agent on it`;
export const resetNoneLine = (agent: string): string => `${agent} banks no resets`;
export const noSuchAccountLine = (word: string): string => `no account ${word}; wsp usage lists every account`;

export const USAGE_RANGES = ["day", "week", "month"] as const;
export const UsageRange = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof UsageRange>;

export const USAGE_SPLITS = ["agent", "account", "computer", "project", "model"] as const;
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

/** One split value's use over a range, wsp's own turns and the agents' logs together. input counts every token the
 * model read, the cached ones included. costList is the rate table's figure for the tokens no harness put a cost on,
 * and priced is false where some of them have no entry in it. */
export const UsedRow = z.object({
  key: z.string(),
  label: z.string(),
  /** The agent every turn of the row ran on, on a split by agent, account or model: a model is filed once per agent
   * that ran it. */
  agent: z.string().optional(),
  tokens: UsageTokens.pick({ input: true, output: true, cached: true }).extend({ cacheWrite: z.number().optional(), reasoning: z.number().optional() }),
  costReported: z.number().optional(),
  costList: z.number().optional(),
  priced: z.boolean(),
  /** The rate table's figure for every token of the row, whatever its harness reported: the API estimate. */
  estimate: z.number().optional(),
  /** What the cached tokens saved at list price: their fresh input price less their cache read price. */
  saved: z.number().optional(),
  turns: z.number().int().optional(),
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
  /** Whose logs the range counted and on which computer, where it counted any: the agents by their names. */
  logs: z.object({ agents: z.array(z.string()), computer: z.string() }).optional(),
  /** Each row's own series, on the same steps as series, so a chart draws one line per split value. */
  lines: z.array(z.object({ key: z.string(), label: z.string(), points: z.array(z.number()) })).optional(),
});
export type UsedAnswer = z.infer<typeof UsedAnswer>;

/** The tokens a row read fresh, the cached and the written ones taken out of its input, so fresh, written, cached and
 * out add up to the row. */
export const freshIn = (tokens: { input: number; cached: number; cacheWrite?: number | undefined }): number => Math.max(0, tokens.input - tokens.cached - (tokens.cacheWrite ?? 0));

/** A list as a sentence reads it: "a", "a and b", "a, b and c". */
export const listWords = (words: readonly string[]): string => (words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

/** What the logs a range counted are, said once under its numbers: the agents that kept them and where. */
export const logsLine = (logs: { agents: readonly string[]; computer: string }): string => `Counts what ${listWords(logs.agents)} logged on ${logs.computer}, wsp's threads there included.`;

const RANGE_WORDS: Record<UsageRange, string> = { day: "today", week: "in the last 7 days", month: "in the last 30 days" };

/** A range's use in one line: the tokens, what they cost and how much of it came from cache. */
export function usedHeadline(used: Pick<UsedAnswer, "range" | "rows">): string {
  const sum = (pick: (row: UsedRow) => number): number => used.rows.reduce((n, row) => n + pick(row), 0);
  const tokens = sum(row => row.tokens.input + row.tokens.output);
  if (tokens === 0) return USAGE_WORDS.noUse;
  const priced = used.rows.some(r => r.costReported !== undefined || r.costList !== undefined);
  const listed = used.rows.some(r => (r.costList ?? 0) > 0);
  const cost = priced ? `, ${fmtCost(sum(r => (r.costReported ?? 0) + (r.costList ?? 0)))}${listed ? ` at ${LIST_PRICE_WORD}` : ""}` : "";
  const cached = sum(row => row.tokens.cached);
  const unpriced = used.rows.some(r => !r.priced) ? " Some of it has no price to read, so the figure leaves it out." : "";
  return `${fmtTokens(tokens)} tokens ${RANGE_WORDS[used.range]}${cost}${cached > 0 ? `, ${fmtTokens(cached)} of it read from cache` : ""}.${unpriced}`;
}

/** An account as a person reads it: the agent and how it pays, by key or by its plan, else the address it signed in
 * as, else your sign-in wsp hands every computer, else the login one computer keeps of its own. */
export function accountWords(o: { agentName: string; keyed?: boolean | undefined; plan?: string | undefined; planBrand?: string | undefined; named?: string | undefined; vaulted?: boolean | undefined; ownOn?: string | undefined }): string {
  if (o.keyed === true) return `${o.agentName} with an API key`;
  if (o.plan !== undefined && o.plan !== "") {
    const plan = o.plan[0]!.toUpperCase() + o.plan.slice(1);
    return `${o.agentName} with ${o.planBrand === undefined ? plan : `${o.planBrand} ${plan}`}`;
  }
  if (o.named !== undefined) return `${o.agentName} as ${o.named}`;
  if (o.vaulted === true) return `${o.agentName} with your sign-in`;
  return o.ownOn === undefined ? o.agentName : `${o.agentName} signed in on ${o.ownOn}`;
}


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

/** A model as its maker names it, without the context window Claude Code writes after it, as in [1m]. */
export const baseModel = (model: string): string => model.replace(/\[[^\]]*\]$/, "");

/** A model's entry as a harness names it: as it is, without a provider in front, or without a date or a context
 * window after it. */
export function rateOf(model: string, table: RateTable): Rate | undefined {
  const bare = baseModel(model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model);
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

/** How long until a moment, as a row's quiet word: minutes under an hour, hours under a day, then days. */
const spanWord = (left: number): string => (left < 3_600_000 ? `${Math.max(1, Math.round(left / 60_000))} min` : left < 86_400_000 ? `${Math.floor(left / 3_600_000)} h` : `${Math.floor(left / 86_400_000)} d`);

/** The resets a plan has banked, as a row's word: how many, and when the first one lapses where the agent said. */
export function creditsWord(credits: { count: number; nextExpiresAt?: number | undefined }, now: number): string {
  if (credits.count === 0) return "none banked";
  const banked = `${credits.count} banked`;
  if (credits.nextExpiresAt === undefined || credits.nextExpiresAt <= now) return banked;
  return `${banked}, ${credits.count === 1 ? "expires" : "first expires"} in ${spanWord(credits.nextExpiresAt - now)}`;
}

/** When a limit was last read, as the row's quiet word: the time today, else the weekday and time. */
export function asOfWord(readAt: number, now: number, timeZone?: string): string {
  const zone = timeZone !== undefined ? { timeZone } : {};
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...zone }).format(readAt);
  if (dayKeyOf(readAt, timeZone) === dayKeyOf(now, timeZone)) return `as of ${time}`;
  return `as of ${new Intl.DateTimeFormat("en-US", { weekday: "short", ...zone }).format(readAt)} ${time}`;
}

/** A used row's price as a row reads it: the figure, with not priced where any of its tokens had no price, since
 * the figure then leaves them out, else list price where any of it came off the table; nothing where no turn
 * carried a price at all. */
export function usedPrice(row: Pick<UsedRow, "costReported" | "costList" | "priced">): { figure?: string; word?: string } {
  const word = !row.priced ? USAGE_WORDS.notPriced : row.costList !== undefined && row.costList > 0 ? USAGE_WORDS.listPrice : undefined;
  const figure = row.costReported === undefined && row.costList === undefined ? undefined : fmtCost((row.costReported ?? 0) + (row.costList ?? 0));
  return { ...(figure !== undefined ? { figure } : {}), ...(word !== undefined ? { word } : {}) };
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
