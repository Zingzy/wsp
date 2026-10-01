// SPDX-License-Identifier: AGPL-3.0-only
// The host's two usage records, kept apart and never added together: the
// ledger of what was used, one document a day of rows keyed by agent, account,
// computer, project and model, and the last reading of what each account may
// still use. Also the rate table the ledger prices bare tokens off.
import {
  AccountLimit,
  PRICES_TTL_MS,
  USAGE_WORDS,
  RANGE_DAYS,
  accountWords,
  baseModel,
  UsageDay,
  dayKeyOf,
  hourOf,
  parseRateTable,
  priceOf,
  rateOf,
  type AccountRoad,
  type AccountRow,
  type AgentSignInState,
  type HarnessLimit,
  type RateTable,
  type TurnTokens,
  type UsageRange,
  type UsageRow,
  type UsageSplit,
  type UsedAnswer,
  type UsedRow,
  HERE_PLACE_ID,
  THIS_COMPUTER,
  hereName,
  placeName,
  providerKeyName,
  type PlaceView,
} from "@wsp/protocol";
import type { Clock } from "./clock.js";
import type { Store } from "./store.js";

/** One day's rows, one blob a day so a turn's end rewrites that day alone and never the state file. */
const USAGE_DAYS = "usage-days";
/** The days the ledger holds, which is what retention reads: a store has no listing of its blobs. */
const USAGE_INDEX = "usage-index";
const LIMITS = "limits";
const ACCOUNT_LABELS = "usage-accounts";
const PRICES = "prices";

/** The documents of the ledger kept, a day each. */
export const USAGE_RETENTION_DAYS = 90;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** One turn's use as the ledger files it: when it ended, the four splits, the model, and what the harness counted. */
export interface UsageEntry {
  at: number;
  agent: string;
  account: string;
  /** What the account reads as, kept beside its key so no reader takes the key apart. */
  accountLabel: string;
  computer: string;
  project: string;
  model?: string;
  /** The turns this entry counts: one, unless it is a second model's share of a turn already counted. */
  turns?: number;
  tokens?: Partial<TurnTokens>;
  costUsd?: number;
  /** The harness's own session id, which a read of the logs skips once a wsp turn was filed under it. */
  session?: string;
  source: "wsp" | "log";
}

export interface UsedQuery {
  range: UsageRange;
  split: UsageSplit;
  /** What a split value reads as: an agent's name, an account's label, a computer's name, a project's name. */
  label: (split: UsageSplit, value: string) => string;
  /** Whether the rows read from the harnesses' own logs are counted; the person can turn that reading off. */
  outside?: boolean;
  /** The computer whose agents' logs were read, by its name, which the answer says the logs were counted on. */
  logsOn?: string;
}

export interface LimitReading {
  key: string;
  agent: string;
  label: string;
  road: AccountRoad;
  computer: string;
  limit: HarnessLimit;
}

export interface UsageLedger {
  add(entry: UsageEntry): Promise<void>;
  /** Every row read from the logs, in place of the last read's: a session a wsp turn was filed under is left out. */
  fileLogs(entries: readonly UsageEntry[]): Promise<void>;
  used(query: UsedQuery): Promise<UsedAnswer>;
  day(day: string): Promise<UsageDay | undefined>;
  days(): Promise<string[]>;
  /** Keeps a reading over the account's last, answering both, so a reader compares them with no write between. */
  limit(reading: LimitReading): Promise<{ before: AccountLimit | undefined; after: AccountLimit }>;
  limits(): Promise<AccountLimit[]>;
  /** Every account a row or a limit was filed under, by key, with what it reads as. */
  accountLabels(): Promise<Map<string, string>>;
}

/** What the vault holds for an agent's sign-in: its token, its key, or nothing. */
export type Vaulted = "token" | "key" | undefined;

/** An account as the usage records key and name it, the one rule the ledger, the limits and the Usage page read: the
 * account the harness named, else the vault's token or key handed to every computer alike, else the login that
 * computer keeps of its own. */
export function accountOf(o: { agent: string; agentName: string; named?: { id: string; label?: string }; vaulted: Vaulted; computer: { id: string; name: string } }): { key: string; label: string; road: AccountRoad } {
  if (o.named !== undefined) return { key: `${o.agent}:${o.named.id}`, label: o.named.label ?? o.named.id, road: "named" };
  if (o.vaulted === "token") return { key: `${o.agent}:vault-token`, label: accountWords({ agentName: o.agentName, vaulted: true }), road: "vault" };
  if (o.vaulted === "key") return { key: `${o.agent}:vault-key`, label: accountWords({ agentName: o.agentName, keyed: true }), road: "vault" };
  return { key: `${o.agent}@${o.computer.id}`, label: accountWords({ agentName: o.agentName, ownOn: o.computer.name }), road: "own" };
}

/** The account an agent's work on a computer runs on, read off the limits its turns there left: the one a turn named,
 * else the vault's key where a turn there ran on it, since a key is one account wherever it is used, else that
 * computer's own login. A vault token stays apart from a login, which may be another person's plan. */
export function accountOnComputer(o: { agent: string; agentName: string; computer: { id: string; name: string }; limits: readonly AccountLimit[]; vaulted: Vaulted }): { key: string; label: string } {
  const ran = (road: (r: AccountRoad | undefined) => boolean) => o.limits.find(l => l.agent === o.agent && road(l.road) && l.computers.includes(o.computer.id));
  return ran(r => r !== "vault") ?? (o.vaulted === "key" ? ran(r => r === "vault") : undefined) ?? accountOf({ agent: o.agent, agentName: o.agentName, vaulted: undefined, computer: o.computer });
}

/** A computer the usage records name by its id, as a person reads it: its row's own name, this computer's, or a
 * provider's by the word its table gives it, never a hostname or a provider's id. */
export function usageComputerName(places: readonly PlaceView[], id: string): string {
  const place = places.find(p => p.id === id);
  if (place !== undefined) return placeName(place);
  return id === HERE_PLACE_ID ? hereName(places) || THIS_COMPUTER : providerKeyName(id);
}

/** The instant a zone's day began, for the day holding `at`. */
function dayStartOf(at: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).formatToParts(at);
  const part = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
  return at - ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000 - (at % 1000);
}

/** A row's value for a split; a model with its context window after it is the same model. */
const splitValue = (row: UsageRow, split: UsageSplit): string => (split === "model" ? baseModel(row.model) : row[split]);

/** The banked resets a reading leaves held: a reading in full replaces them and stamps the detail, a count alone
 * keeps the held details while the count stands and drops them once it moved, and a reading that carries none
 * leaves them as they were. */
function creditsHeld(held: AccountLimit["credits"], read: HarnessLimit["credits"], now: number): AccountLimit["credits"] {
  if (read === undefined) return held;
  if (read.credits !== undefined) return { count: read.count, credits: read.credits, readAt: now, detailAt: now };
  return held !== undefined && held.count === read.count ? { ...held, readAt: now } : { count: read.count, readAt: now };
}

/** The resets on a row: what the account holds, with the soonest an available one lapses. */
function rowCredits(held: NonNullable<AccountLimit["credits"]>): AccountRow["credits"] {
  const lapses = (held.credits ?? []).flatMap(c => (c.status === "available" && c.expiresAt !== undefined ? [c.expiresAt] : []));
  return { ...held, ...(lapses.length > 0 ? { nextExpiresAt: Math.min(...lapses) } : {}) };
}

const rowKey = (row: Omit<UsageRow, "turns" | "tokens" | "costReported">): string =>
  [row.hour, row.agent, row.account, row.computer, row.project, row.model, row.source].join("\u0000");


export function createUsageLedger(o: { store: Store; clock: Clock; timeZone?: string; prices: () => Promise<RateTable>; retentionDays?: number }): UsageLedger {
  const zone = o.timeZone;
  const keepDays = o.retentionDays ?? USAGE_RETENTION_DAYS;
  // Every write of the ledger takes its turn, so two turns ending at once never both read a day and one write lost.
  let writes: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writes.then(work);
    writes = run.catch(() => {});
    return run;
  };

  const readDay = async (day: string): Promise<UsageDay | undefined> => {
    const bytes = await o.store.getBlob(USAGE_DAYS, day);
    if (bytes === undefined) return undefined;
    const parsed = UsageDay.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  };
  const index = async (): Promise<string[]> => {
    const held = (await o.store.get(USAGE_INDEX, "days")) as { days?: unknown } | undefined;
    return Array.isArray(held?.days) ? held.days.filter((d): d is string => typeof d === "string") : [];
  };

  /** One entry into a day's rows: a key it shares folds into that row, the harness's session is noted for a wsp turn. */
  const fold = (held: UsageDay, entry: UsageEntry): void => {
    const day = held.day;
    const key = {
      day,
      hour: hourOf(entry.at, zone),
      agent: entry.agent,
      account: entry.account,
      computer: entry.computer,
      project: entry.project,
      model: entry.model ?? "",
      source: entry.source,
    };
    const t = entry.tokens ?? {};
    const tokens = {
      input: t.input ?? 0,
      output: t.output ?? 0,
      cached: t.cached ?? 0,
      cacheWrite: t.cacheWrite ?? 0,
      reasoning: t.reasoning ?? 0,
    };
    const found = held.rows.find(r => rowKey(r) === rowKey(key));
    if (found === undefined) {
      held.rows.push({
        ...key,
        turns: entry.turns ?? 1,
        tokens,
        ...(entry.costUsd !== undefined ? { costReported: entry.costUsd } : {}),
      });
    } else {
      found.turns += entry.turns ?? 1;
      for (const field of ["input", "output", "cached", "cacheWrite", "reasoning"] as const) found.tokens[field] += tokens[field];
      if (entry.costUsd !== undefined) found.costReported = (found.costReported ?? 0) + entry.costUsd;
    }
    if (entry.source === "wsp" && entry.session !== undefined && !(held.sessions ?? []).includes(entry.session)) held.sessions = [...(held.sessions ?? []), entry.session];
  };

  /** A day written back, and retention run over the index as it is. */
  const write = async (held: UsageDay): Promise<void> => {
    const day = held.day;
    await o.store.putBlob(USAGE_DAYS, day, Buffer.from(JSON.stringify(held)));
    // Retention runs as a day is filed, off the index of the days held.
    const oldest = dayKeyOf(o.clock.now() - (keepDays - 1) * DAY, zone);
    const days = [...new Set([...(await index()), day])].sort();
    const kept = days.filter(d => d >= oldest);
    for (const gone of days.filter(d => d < oldest)) await o.store.deleteBlob(USAGE_DAYS, gone);
    await o.store.put(USAGE_INDEX, "days", { days: kept });
  };

  const nameAccounts = async (named: ReadonlyArray<{ key: string; label: string }>): Promise<void> => {
    for (const { key, label } of new Map(named.map(n => [n.key, n])).values()) {
      const held = (await o.store.get(ACCOUNT_LABELS, key)) as { label?: unknown } | undefined;
      if (held?.label !== label) await o.store.put(ACCOUNT_LABELS, key, { key, label });
    }
  };

  const add = (entry: UsageEntry): Promise<void> =>
    inTurn(async () => {
      await nameAccounts([{ key: entry.account, label: entry.accountLabel }]);
      const day = dayKeyOf(entry.at, zone);
      const held = (await readDay(day)) ?? { day, rows: [] };
      fold(held, entry);
      await write(held);
    });

  const fileLogs = (entries: readonly UsageEntry[]): Promise<void> =>
    inTurn(async () => {
      await nameAccounts(entries.map(e => ({ key: e.account, label: e.accountLabel })));
      const oldest = dayKeyOf(o.clock.now() - (keepDays - 1) * DAY, zone);
      const days = new Map<string, UsageDay>();
      for (const day of await index()) {
        const held = await readDay(day);
        if (held !== undefined) days.set(day, held);
      }
      const ran = new Set([...days.values()].flatMap(d => d.sessions ?? []));
      // The last read's rows go, from every day it filed into, before this read's are folded in.
      const touched = new Set<string>();
      for (const held of days.values()) {
        if (!held.rows.some(r => r.source === "log")) continue;
        held.rows = held.rows.filter(r => r.source !== "log");
        touched.add(held.day);
      }
      for (const entry of entries) {
        if (entry.session !== undefined && ran.has(entry.session)) continue;
        const day = dayKeyOf(entry.at, zone);
        if (day < oldest) continue;
        const held = days.get(day) ?? { day, rows: [] };
        fold(held, { ...entry, source: "log" });
        days.set(day, held);
        touched.add(day);
      }
      for (const day of touched) await write(days.get(day)!);
    });

  const used = async (q: UsedQuery): Promise<UsedAnswer> => {
    // The writes already asked for land first, so a turn's rows are read the moment its end is.
    await writes;
    const now = o.clock.now();
    const today = dayStartOf(now, zone);
    const count = RANGE_DAYS[q.range];
    const since = count === 1 ? today : dayStartOf(today - (count - 1) * DAY + HOUR * 12, zone);
    // Each day of the range by its own start, stepped from noon so a clock change never skips or repeats one.
    const starts = Array.from({ length: count }, (_, i) => dayStartOf(today - (count - 1 - i) * DAY + HOUR * 12, zone));
    // The table is read only once a row is found, so an empty range asks for no download.
    let table: RateTable | undefined;
    const outside = q.outside ?? true;
    const rows = new Map<string, UsedRow>();
    const logged = new Set<string>();
    const series =
      count === 1
        ? Array.from({ length: 24 }, (_, h) => ({
            t: today + h * HOUR,
            tokens: 0,
          }))
        : starts.map(t => ({ t, tokens: 0 }));
    const points = new Map<string, number[]>();
    for (const [at, start] of starts.entries()) {
      const held = await readDay(dayKeyOf(start + HOUR * 12, zone));
      for (const row of held?.rows ?? []) {
        if (row.source === "log" && !outside) continue;
        if (row.source === "log") logged.add(row.agent);
        const key = splitValue(row, q.split);
        const line = rows.get(key) ?? {
          key,
          label: q.label(q.split, key),
          tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
          priced: true,
          turns: 0,
        };
        for (const field of ["input", "output", "cached", "cacheWrite", "reasoning"] as const) line.tokens[field] = (line.tokens[field] ?? 0) + row.tokens[field];
        // A log keeps sessions and no turns, so turns count the ones wsp ran.
        if (row.source === "wsp") line.turns = (line.turns ?? 0) + row.turns;
        table ??= await o.prices();
        const listed = priceOf(row.model, row.tokens, table);
        const rate = rateOf(row.model, table);
        if (listed !== undefined && rate !== undefined) {
          line.estimate = (line.estimate ?? 0) + listed;
          line.saved = (line.saved ?? 0) + row.tokens.cached * (rate.input - (rate.cacheRead ?? rate.input));
        }
        if (row.costReported !== undefined) line.costReported = (line.costReported ?? 0) + row.costReported;
        else if (listed !== undefined) line.costList = (line.costList ?? 0) + listed;
        else if (row.tokens.input + row.tokens.output > 0) line.priced = false;
        rows.set(key, line);
        const step = count === 1 ? row.hour : at;
        if (series[step] !== undefined) {
          series[step].tokens += row.tokens.input + row.tokens.output;
          const line = points.get(key) ?? series.map(() => 0);
          line[step]! += row.tokens.input + row.tokens.output;
          points.set(key, line);
        }
      }
    }
    const ordered = [...rows.values()].sort((a, b) => b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output) || a.key.localeCompare(b.key));
    // The range ends where today does, so two reads a moment apart answer the same range.
    const logs = logged.size === 0 || q.logsOn === undefined ? {} : { logs: { agents: [...logged].map(agent => q.label("agent", agent)).sort(), computer: q.logsOn } };
    const lines = ordered.map(row => ({ key: row.key, label: row.label, points: points.get(row.key) ?? series.map(() => 0) }));
    return {
      range: q.range,
      split: q.split,
      rows: ordered,
      series,
      lines,
      since,
      until: dayStartOf(today + DAY + HOUR * 12, zone),
      ...logs,
    };
  };

  const limit = (r: LimitReading): Promise<{ before: AccountLimit | undefined; after: AccountLimit }> =>
    inTurn(async () => {
      const heldRaw = await o.store.get(LIMITS, r.key);
      const held = heldRaw === undefined ? undefined : AccountLimit.safeParse(heldRaw).data;
      const plan = r.limit.plan ?? held?.plan;
      const status = r.limit.status ?? held?.status;
      const keyed = r.limit.keyed ?? held?.keyed;
      const credits = keyed === true ? undefined : creditsHeld(held?.credits, r.limit.credits, o.clock.now());
      await nameAccounts([{ key: r.key, label: r.label }]);
      const next: AccountLimit = {
        key: r.key,
        agent: r.agent,
        label: r.label,
        road: r.road,
        ...(plan !== undefined ? { plan } : {}),
        windows: r.limit.windows.length > 0 || r.limit.keyed === true ? r.limit.windows : (held?.windows ?? []),
        ...(status !== undefined ? { status } : {}),
        ...(keyed !== undefined ? { keyed } : {}),
        readAt: o.clock.now(),
        computers: [...new Set([...(held?.computers ?? []), r.computer])],
        ...(credits !== undefined ? { credits } : {}),
      };
      await o.store.put(LIMITS, r.key, next);
      return { before: held, after: next };
    });

  const limits = async (): Promise<AccountLimit[]> =>
    (await o.store.list(LIMITS)).flatMap(raw => {
      const parsed = AccountLimit.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });

  const accountLabels = async (): Promise<Map<string, string>> => {
    const labels = new Map<string, string>();
    for (const raw of await o.store.list(ACCOUNT_LABELS)) {
      const held = raw as { key?: unknown; label?: unknown };
      if (typeof held.key === "string" && typeof held.label === "string") labels.set(held.key, held.label);
    }
    return labels;
  };

  return { add, fileLogs, used, day: readDay, days: index, limit, limits, accountLabels };
}

/** How far back an account's draw right now reaches. */
export const BURN_WINDOW_MS = 15 * 60_000;

/** A call a run re-read after a host restart replayed: the run it came from and the moment the agent's machine
 * stamped on it, on that machine's clock. */
export interface ReplayedStamp {
  run: string;
  at: number;
}

/** What each account's running threads drew over the last fifteen minutes, off the calls their turns reported. Kept in
 * memory alone: a reading this old is gone by the time a host has restarted. A call is filed when this host received
 * it. A run re-read after a restart hands its old calls over all at once, so each of its calls is filed by its age
 * against the newest stamp that run has given, counted back from when that newest one arrived: two stamps of one
 * machine are compared, never a machine's clock against this host's. */
export function createBurn(clock: Clock): { add(o: { account: string; threadId: string; tokens: number; replayed?: ReplayedStamp }): void; of(account: string): AccountRow["burn"] } {
  let calls: { receivedAt: number; account: string; threadId: string; tokens: number; replayed?: ReplayedStamp }[] = [];
  /** Each re-read run's newest stamp and when it arrived. */
  const newest = new Map<string, { at: number; receivedAt: number }>();
  const filedAt = (c: (typeof calls)[number]): number => {
    const top = c.replayed === undefined ? undefined : newest.get(c.replayed.run);
    return c.replayed === undefined || top === undefined ? c.receivedAt : Math.min(c.receivedAt, top.receivedAt - (top.at - c.replayed.at));
  };
  const recent = () => {
    const since = clock.now() - BURN_WINDOW_MS;
    calls = calls.filter(c => filedAt(c) > since);
    const runs = new Set(calls.flatMap(c => (c.replayed !== undefined ? [c.replayed.run] : [])));
    for (const run of newest.keys()) if (!runs.has(run)) newest.delete(run);
    return calls;
  };
  return {
    add: o => {
      const receivedAt = clock.now();
      if (o.replayed !== undefined && o.replayed.at >= (newest.get(o.replayed.run)?.at ?? -Infinity)) newest.set(o.replayed.run, { at: o.replayed.at, receivedAt });
      recent().push({ receivedAt, ...o });
    },
    of: account => {
      const on = recent().filter(c => c.account === account);
      if (on.length === 0) return undefined;
      return { tokensPerMinute: on.reduce((n, c) => n + c.tokens, 0) / (BURN_WINDOW_MS / 60_000), threads: new Set(on.map(c => c.threadId)).size };
    },
  };
}

/** The rate table, read off LiteLLM's price file once a day and kept under the wsp home, so a host offline prices
 * off the last one it read. Nothing is sent in the read. */
export function createPriceTable(o: { store: Store; clock: Clock; fetch: () => Promise<unknown> }): { get(): Promise<RateTable> } {
  let held: { fetchedAt: number; table: RateTable } | undefined;
  let reading: Promise<RateTable> | undefined;
  const fresh = (): boolean => held !== undefined && o.clock.now() - held.fetchedAt < PRICES_TTL_MS;
  const refresh = async (): Promise<RateTable> => {
    if (held === undefined) {
      const bytes = await o.store.getBlob(PRICES, "litellm");
      if (bytes !== undefined) {
        const kept = JSON.parse(bytes.toString("utf8")) as {
          fetchedAt?: unknown;
          table?: unknown;
        };
        if (typeof kept.fetchedAt === "number" && typeof kept.table === "object" && kept.table !== null) held = { fetchedAt: kept.fetchedAt, table: kept.table as RateTable };
      }
      if (fresh()) return held!.table;
    }
    try {
      const table = parseRateTable(await o.fetch());
      if (Object.keys(table).length > 0) {
        held = { fetchedAt: o.clock.now(), table };
        await o.store.putBlob(PRICES, "litellm", Buffer.from(JSON.stringify(held)));
      }
    } catch (e) {
      console.warn(`the price table was not read (${e instanceof Error ? e.message : String(e)}); ${held === undefined ? "no row is priced" : "the last one read is used"}`);
    }
    return held?.table ?? {};
  };
  return {
    get: async () => {
      if (fresh()) return held!.table;
      reading ??= refresh().finally(() => (reading = undefined));
      return reading;
    },
  };
}

/** Every account row the Usage page lists: each account a turn has read limits for, and each sign-in any computer
 * reports, folded by the account it stands for. The vault's token or key is one account on every computer it was
 * handed to; a login a computer keeps of its own is that computer's, until a turn there names the account it is. */
export function accountRows(o: {
  limits: readonly AccountLimit[];
  places: readonly {
    id: string;
    name: string;
    signIns?: Readonly<Record<string, AgentSignInState>>;
  }[];
  nameOf: (placeId: string) => string;
  agentName: (agent: string) => string;
  /** The name the agent's plans are sold under, where the catalog gives one. */
  planBrand?: (agent: string) => string | undefined;
  /** What the vault holds for an agent: a token, a key, or nothing. */
  vaulted: (agent: string) => Vaulted;
  /** Whether the agent prints its plan's limits in a turn, as the catalog says. */
  printsLimits: (agent: string) => boolean;
  /** What the account's running threads are drawing on it now, where any did. */
  burn?: (key: string) => AccountRow["burn"];
}): AccountRow[] {
  const rows = new Map<string, AccountRow>();
  const noteFor = (agent: string, keyed: boolean | undefined): AccountRow["note"] =>
    keyed === true ? USAGE_WORDS.keyed : o.printsLimits(agent) ? USAGE_WORDS.unread : USAGE_WORDS.noLimit;
  for (const l of o.limits) {
    const read = l.windows.length > 0;
    rows.set(l.key, {
      key: l.key,
      agent: l.agent,
      label: accountWords({ agentName: o.agentName(l.agent), keyed: l.keyed, plan: l.plan, planBrand: o.planBrand?.(l.agent), named: l.road === "named" ? l.label : undefined, vaulted: l.road === "vault", ownOn: l.road === "own" && l.computers[0] !== undefined ? o.nameOf(l.computers[0]) : undefined }),
      computers: l.computers.map(o.nameOf),
      ...(l.plan !== undefined ? { plan: l.plan } : {}),
      ...(read ? { windows: l.windows, readAt: l.readAt } : {}),
      ...(read && l.status !== undefined ? { status: l.status } : {}),
      ...(read ? {} : { note: noteFor(l.agent, l.keyed) }),
      ...(l.credits !== undefined ? { credits: rowCredits(l.credits) } : {}),
    });
  }
  for (const place of o.places) {
    for (const [agent, state] of Object.entries(place.signIns ?? {})) {
      if (state === "none") continue;
      const held = state === "vault-key" ? o.vaulted(agent) : undefined;
      const computer = { id: place.id, name: o.nameOf(place.id) };
      const { key, label } = held !== undefined ? accountOf({ agent, agentName: o.agentName(agent), vaulted: held, computer }) : accountOnComputer({ agent, agentName: o.agentName(agent), computer, limits: o.limits, vaulted: o.vaulted(agent) });
      const row = rows.get(key) ?? { key, agent, label, computers: [], note: noteFor(agent, held === "key") };
      const name = o.nameOf(place.id);
      if (!row.computers.includes(name)) row.computers = [...row.computers, name];
      rows.set(key, row);
    }
  }
  // Two accounts of one agent that read the same, two logins on one plan, keep the address each signed in as.
  const addresses = new Map(o.limits.flatMap(l => (l.road === "named" ? [[l.key, l.label] as const] : [])));
  const shared = new Set([...rows.values()].map(row => row.label).filter((label, at, all) => all.indexOf(label) !== at));
  for (const row of rows.values()) {
    const address = addresses.get(row.key);
    if (shared.has(row.label) && address !== undefined && !row.label.endsWith(` as ${address}`)) row.label = `${row.label} as ${address}`;
    const burn = o.burn?.(row.key);
    if (burn !== undefined) row.burn = burn;
  }
  return [...rows.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.label.localeCompare(b.label));
}
