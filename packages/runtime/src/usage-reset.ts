// SPDX-License-Identifier: AGPL-3.0-only
// Spending one of an account's banked plan resets, on a computer of the
// person's that holds the account's login. Two short runs of the agent there:
// a read that checks the login is still the account named and how many are
// banked, then the spend under an idempotency key, which reads the account
// again. The key is written before the spend and kept until the agent answered
// it, across a timeout, a lost link and a host restart, so a press after an
// unanswered one sends the same request rather than a second one; one whose
// read finds fewer banked than before the first attempt spends nothing more,
// since that press, an expiry or a spend elsewhere all read the same. A second
// press while one runs joins it and gets the same answer.
import {
  absentComputer,
  markedCut,
  noSuchAccountLine,
  providerKeyName,
  resetKeyedLine,
  resetMismatchLine,
  resetNoneLine,
  resetNotOnLine,
  resetProviderOnlyLine,
  resetRefusedLine,
  resetSignedOutLine,
  resetSilentLine,
  resetUnreadLine,
  resetWho,
  RESET_WORDS,
  USAGE_WORDS,
  type AccountLimit,
  type AccountRow,
  type HarnessLimit,
  type PlanResets,
  type ResetAnswer,
  type ResetOutcome,
  type ResetRoad,
} from "@wsp/protocol";
import type { Store } from "./store.js";

/** The idempotency key of a spend the agent has not answered, by account, with the count banked before it. */
const PENDING = "usage-reset-pending";

/** A computer a reset may run on, as the host knows it now. */
export interface ResetPlace {
  id: string;
  name: string;
  /** This computer, a box the person joined, or a provider's machines, which no reset runs on. */
  kind: "here" | "box" | "provider";
  connected: boolean;
  /** Whether the agent's own login stands there. */
  signedIn: (agent: string) => boolean;
}

export interface UsageResetDeps {
  store: Store;
  limits(): Promise<AccountLimit[]>;
  agentName(agent: string): string;
  resets(agent: string): PlanResets | undefined;
  /** Each computer by id as the host knows it at the moment a spend starts. */
  places(): Promise<(id: string) => ResetPlace>;
  /** Where the agent's login lives on that computer; refuses with the sentence when it cannot be read. */
  road(agent: string, place: ResetPlace): Promise<ResetRoad>;
  /** One script there, answering what it printed. */
  run(place: ResetPlace, script: string): Promise<string>;
  /** Files a reading the way a turn's is filed, answering the key it went under. */
  file(o: { agent: string; place: ResetPlace; limit: HarnessLimit }): Promise<string>;
  row(key: string): Promise<AccountRow | undefined>;
  uuid(): string;
}

export interface ResetAsk {
  account: string;
  creditId?: string;
  /** The place to spend it on, where the person named one. */
  on?: string;
}

const KNOWN: readonly ResetOutcome[] = ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"];

const usage = (sentence: string, kind = "usage"): Error => Object.assign(new Error(sentence), { kind });

export function usageResets(d: UsageResetDeps): (ask: ResetAsk) => Promise<ResetAnswer> {
  const running = new Map<string, Promise<ResetAnswer>>();

  /** The computer the spend runs on: the one an own login is kept on, else the first of the account's computers in
   * the order it was read on that holds its login and is connected, or the one the person named. */
  const pick = (placeOf: (id: string) => ResetPlace, ask: ResetAsk, agent: string, label: string, limit: AccountLimit | undefined, own: string | undefined): ResetPlace => {
    const ids = own !== undefined ? [own] : (limit?.computers ?? []);
    const mine = ids.map(placeOf).filter(p => p.kind !== "provider");
    if (mine.length === 0) {
      const provider = ids[0];
      throw usage(provider === undefined ? resetSignedOutLine(label, d.agentName(agent)) : resetProviderOnlyLine(label, providerKeyName(provider), d.agentName(agent)));
    }
    const holding = own !== undefined ? mine : mine.filter(p => p.signedIn(agent));
    if (holding.length === 0) throw usage(resetSignedOutLine(label, d.agentName(agent)));
    if (ask.on !== undefined) {
      const named = holding.find(p => p.id === ask.on);
      if (named === undefined) throw usage(resetNotOnLine(label, placeOf(ask.on).name, holding.map(p => p.name)));
      if (!named.connected) throw new Error(absentComputer(named.name, null).sentence);
      return named;
    }
    const first = holding.find(p => p.connected);
    if (first === undefined) throw new Error(absentComputer(holding[0]!.name, null).sentence);
    return first;
  };

  const spend = async (ask: ResetAsk): Promise<ResetAnswer> => {
    const limits = await d.limits();
    const limit = limits.find(l => l.key === ask.account);
    const row = await d.row(ask.account);
    const own = /^([^:@]+)@(.+)$/.exec(ask.account) ?? undefined;
    const agent = limit?.agent ?? row?.agent ?? own?.[1];
    if (agent === undefined) throw usage(noSuchAccountLine(ask.account), "not-found");
    const resets = d.resets(agent);
    if (resets === undefined) throw usage(resetNoneLine(d.agentName(agent)));
    const label = row?.label ?? limit?.label ?? ask.account;
    if (limit?.keyed === true || limit?.road === "vault" || row?.note === USAGE_WORDS.keyed) throw usage(resetKeyedLine(label));
    const place = pick(await d.places(), ask, agent, label, limit, own?.[2]);
    const name = d.agentName(agent);
    const who = resetWho({ label, own: own !== undefined, computer: place.name });
    const road = await d.road(agent, place);

    const read = resets.parseRead(await d.run(place, resets.readCommand(road)));
    if (read?.keyed === true) throw usage(resetKeyedLine(label));
    if (read?.limit === undefined) throw new Error(resetUnreadLine(name, place.name, label));
    const signedIn = read.limit.account;
    const expected = ask.account.slice(agent.length + 1);
    if (limit?.road === "named" && signedIn?.id !== expected && signedIn?.label !== expected) {
      throw new Error(resetMismatchLine(name, place.name, signedIn?.label ?? signedIn?.id ?? "another account", limit.label));
    }
    const filed = await d.file({ agent, place, limit: read.limit });
    const banked = read.limit.credits?.count;
    if (banked === undefined) throw new Error(`${name} on ${place.name} ${resets.tooOld}`);
    const pending = (await d.store.get(PENDING, ask.account)) as { key?: unknown; before?: unknown } | undefined;
    const before = typeof pending?.before === "number" ? pending.before : undefined;
    const answer = async (outcome: ResetOutcome, said: string, key = filed): Promise<ResetAnswer> => {
      const account = await d.row(key);
      return { outcome, said, ...(account !== undefined ? { account } : {}) };
    };
    if (typeof pending?.key === "string" && before !== undefined && banked < before) {
      await d.store.delete(PENDING, ask.account);
      return answer("earlier", RESET_WORDS.earlier(who, banked));
    }
    if (banked === 0) return answer("noCredit", RESET_WORDS.noCredit(who));

    const key = typeof pending?.key === "string" ? pending.key : d.uuid();
    let script: string;
    try {
      script = resets.spendCommand({ ...road, idempotencyKey: key, ...(ask.creditId !== undefined ? { creditId: ask.creditId } : {}) });
    } catch (e) {
      throw usage(e instanceof Error ? e.message : String(e));
    }
    await d.store.put(PENDING, ask.account, { key, before: before ?? banked });
    const spent = resets.parseSpend(await d.run(place, script));
    if (!spent.answered) {
      console.warn(`the reset of ${label} on ${place.name} went unanswered; the same request goes again on the next press`);
      throw new Error(resetSilentLine(name, place.name));
    }
    await d.store.delete(PENDING, ask.account);
    if ("refused" in spent) throw new Error(spent.tooOld ? `${name} on ${place.name} ${resets.tooOld}` : resetRefusedLine(name, place.name, label, markedCut(spent.refused)));
    const after = spent.limit === undefined ? filed : await d.file({ agent, place, limit: spent.limit });
    const left = spent.limit?.credits?.count;
    const outcome = KNOWN.find(o => o === spent.outcome) ?? "unknown";
    const said =
      outcome === "reset"
        ? RESET_WORDS.reset(who, left)
        : outcome === "nothingToReset"
          ? RESET_WORDS.nothingToReset(who)
          : outcome === "noCredit"
            ? RESET_WORDS.noCredit(who)
            : outcome === "alreadyRedeemed"
              ? RESET_WORDS.alreadyRedeemed(who)
              : RESET_WORDS.unknown(name, spent.outcome, who);
    return answer(outcome, said, after);
  };

  return ask => {
    const held = running.get(ask.account);
    if (held !== undefined) return held;
    const run = spend(ask).finally(() => running.delete(ask.account));
    running.set(ask.account, run);
    return run;
  };
}
