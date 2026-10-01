// SPDX-License-Identifier: AGPL-3.0-only
// Spending a banked reset: which computer it runs on, what is refused before anything runs there, the read that
// checks the login before the spend, the key kept across a spend nobody answered, and the words each answer says.
// The agent's two scripts are stand-ins whose output each case writes; the scripts themselves are proved against a
// fake app server in the Codex adapter's own tests.
import { describe, expect, it } from "vitest";
import { absentComputer, type AccountLimit, type AccountRow, type HarnessLimit, type PlanResets, type ResetReading, type ResetSpend } from "@wsp/protocol";
import { memoryStore } from "../src/store.js";
import { usageResets, type ResetPlace } from "../src/usage-reset.js";

const KEY = "codex:acct_a";
const named = (o: Partial<AccountLimit> = {}): AccountLimit => ({ key: KEY, agent: "codex", label: "a@example.com", road: "named", plan: "plus", windows: [{ kind: "session", usedPercent: 100 }], readAt: 1, computers: ["pl_spoo"], ...o });
const reading = (count: number | undefined, account: { id: string; label?: string } = { id: "acct_a", label: "a@example.com" }): ResetReading => ({
  keyed: false,
  limit: { windows: [{ kind: "session", usedPercent: 100 }], account, ...(count !== undefined ? { credits: { count, credits: [] } } : {}) },
});
const spent = (outcome: string, left?: number): ResetSpend => ({ answered: true, outcome, ...(left !== undefined ? { limit: { windows: [{ kind: "session", usedPercent: 0 }], credits: { count: left } } } : {}) });

const PLACES: Record<string, ResetPlace> = {
  here: { id: "here", name: "Mac", kind: "here", connected: true, signedIn: () => true },
  pl_spoo: { id: "pl_spoo", name: "spoo", kind: "box", connected: true, signedIn: () => true },
  pl_boat: { id: "pl_boat", name: "Boat", kind: "box", connected: false, signedIn: () => true },
  pl_out: { id: "pl_out", name: "Out", kind: "box", connected: true, signedIn: () => false },
  solari: { id: "solari", name: "solari", kind: "provider", connected: true, signedIn: () => true },
};

/** The deps over a store and the answers each script gets, recording every script run and every reading filed. */
function harness(o: { limits?: AccountLimit[]; rows?: AccountRow[]; reads?: (ResetReading | undefined)[]; spends?: (ResetSpend | Error | Promise<never>)[] }) {
  const store = memoryStore();
  const runs: { place: string; script: string }[] = [];
  const filed: HarnessLimit[] = [];
  const reads = [...(o.reads ?? [])];
  const spends = [...(o.spends ?? [])];
  const resets: PlanResets = {
    readCommand: road => `READ ${road.home}`,
    parseRead: () => reads.shift(),
    spendCommand: road => {
      if (road.creditId?.includes("'") === true) throw new Error(`creditId must be a plain slug, got "${road.creditId}"`);
      return `SPEND ${road.idempotencyKey} ${road.creditId ?? "-"}`;
    },
    parseSpend: out => JSON.parse(out) as ResetSpend,
    tooOld: "is older than 0.141 and has no resets",
  };
  let minted = 0;
  const reset = usageResets({
    store,
    limits: async () => o.limits ?? [named()],
    agentName: agent => (agent === "codex" ? "Codex" : agent),
    resets: agent => (agent === "codex" ? resets : undefined),
    places: async () => id => PLACES[id] ?? { id, name: id, kind: "box", connected: false, signedIn: () => false },
    road: async (_agent, place) => ({ home: `/logins/${place.id}/codex` }),
    run: async (place, script) => {
      runs.push({ place: place.id, script });
      if (!script.startsWith("SPEND")) return "";
      const next = spends.shift() ?? spent("reset", 1);
      if (next instanceof Error) throw next;
      return JSON.stringify(await next);
    },
    file: async ({ limit }) => {
      filed.push(limit);
      return KEY;
    },
    row: async (key): Promise<AccountRow | undefined> => o.rows?.find(r => r.key === key) ?? (key === KEY ? { key, agent: "codex", label: "Codex with ChatGPT Plus", computers: ["spoo"] } : undefined),
    uuid: () => `key-${++minted}`,
  });
  const spendRuns = () => runs.filter(r => r.script.startsWith("SPEND"));
  return { reset, store, runs, spendRuns, filed };
}

describe("which computer a reset runs on", () => {
  it("the first of the account's computers that holds its login and is connected, a provider's machines never", async () => {
    const h = harness({ limits: [named({ computers: ["solari", "pl_boat", "pl_out", "pl_spoo"] })], reads: [reading(2)] });
    await h.reset({ account: KEY });
    expect(h.runs.map(r => r.place)).toEqual(["pl_spoo", "pl_spoo"]);
    expect(h.runs[0]!.script).toBe("READ /logins/pl_spoo/codex");
  });

  it("the one the person named, refused with the computer's own sentence when it is away and nothing run", async () => {
    const h = harness({ limits: [named({ computers: ["pl_spoo", "pl_boat"] })], reads: [reading(2)] });
    await expect(h.reset({ account: KEY, on: "pl_boat" })).rejects.toThrow(absentComputer("Boat", null).sentence);
    await expect(h.reset({ account: KEY, on: "here" })).rejects.toThrow("Codex with ChatGPT Plus is not signed in on Mac; it is on spoo and Boat");
    expect(h.runs).toEqual([]);
  });

  it("a box that is away when it is the only one, refused in its own words with nothing run and no key kept", async () => {
    const h = harness({ limits: [named({ computers: ["pl_boat"] })] });
    await expect(h.reset({ account: KEY })).rejects.toThrow(absentComputer("Boat", null).sentence);
    expect(h.runs).toEqual([]);
    expect(await h.store.list("usage-reset-pending")).toEqual([]);
  });

  it("the computer an own login is kept on", async () => {
    const h = harness({ limits: [], reads: [reading(2, { id: "acct_z" })] });
    await h.reset({ account: "codex@here" });
    expect(h.runs.map(r => r.place)).toEqual(["here", "here"]);
  });

  it("refuses a login that lives only on a provider's machines, naming them", async () => {
    const h = harness({ limits: [named({ computers: ["solari"] })] });
    await expect(h.reset({ account: KEY })).rejects.toThrow("Codex with ChatGPT Plus lives only on Solari machines; sign Codex in on a computer of yours");
    expect(h.runs).toEqual([]);
  });
});

describe("what is refused before anything is spent", () => {
  it("an account signed in by key, before any process runs", async () => {
    for (const limit of [named({ keyed: true }), named({ key: "codex:vault-key", road: "vault" })]) {
      const h = harness({ limits: [limit] });
      await expect(h.reset({ account: limit.key })).rejects.toMatchObject({ kind: "usage", message: expect.stringMatching(/pays per token; an API key has no reset to use$/) });
      expect(h.runs).toEqual([]);
    }
  });

  it("the vault's key, which no turn has read a limit for yet, before any process runs", async () => {
    const h = harness({ limits: [], rows: [{ key: "codex:vault-key", agent: "codex", label: "Codex with an API key", computers: ["spoo"], note: "pays per token, no plan limit" }] });
    await expect(h.reset({ account: "codex:vault-key" })).rejects.toThrow("Codex with an API key pays per token; an API key has no reset to use");
    expect(h.runs).toEqual([]);
  });

  it("a computer whose login reads as a key now, after the read and before any spend", async () => {
    const h = harness({ reads: [{ keyed: true }] });
    await expect(h.reset({ account: KEY })).rejects.toThrow("Codex with ChatGPT Plus pays per token; an API key has no reset to use");
    expect(h.spendRuns()).toEqual([]);
  });

  it("a computer signed in as another account now, whose credit would be theirs", async () => {
    const h = harness({ reads: [reading(2, { id: "acct_b", label: "b@example.com" })] });
    await expect(h.reset({ account: KEY })).rejects.toThrow("Codex on spoo is now signed in as b@example.com, not a@example.com; nothing was spent");
    expect(h.spendRuns()).toEqual([]);
  });

  it("an account no limit names and an agent that banks none", async () => {
    await expect(harness({}).reset({ account: "nope" })).rejects.toMatchObject({ kind: "not-found" });
    await expect(harness({ limits: [named({ key: "claude:x", agent: "claude" })] }).reset({ account: "claude:x" })).rejects.toThrow("claude banks no resets");
  });

  it("a credit id the agent would not take, as a usage refusal with nothing spent and no key kept", async () => {
    const h = harness({ reads: [reading(2)] });
    await expect(h.reset({ account: KEY, creditId: "rc'1" })).rejects.toMatchObject({ kind: "usage", message: 'creditId must be a plain slug, got "rc\'1"' });
    expect(h.spendRuns()).toEqual([]);
    expect(await h.store.list("usage-reset-pending")).toEqual([]);
  });

  it("nothing banked on the read, with no spend", async () => {
    const h = harness({ reads: [reading(0)] });
    expect(await h.reset({ account: KEY })).toMatchObject({ outcome: "noCredit", said: "No reset banked on Codex with ChatGPT Plus on spoo" });
    expect(h.spendRuns()).toEqual([]);
  });

  it("a build whose read carries no resets at all, as older than resets", async () => {
    const h = harness({ reads: [reading(undefined)] });
    await expect(h.reset({ account: KEY })).rejects.toThrow("Codex on spoo is older than 0.141 and has no resets");
    expect(h.spendRuns()).toEqual([]);
  });
});

describe("a spend", () => {
  it("says each answer in its words, the reading after it filed, a word it does not know never read as a reset", async () => {
    const cases: [ResetSpend, string, string][] = [
      [spent("reset", 1), "reset", "Reset used: Codex with ChatGPT Plus on spoo's windows start again now, 1 left"],
      [spent("nothingToReset"), "nothingToReset", "No window of Codex with ChatGPT Plus on spoo is in use right now, so the credit was kept"],
      [spent("noCredit"), "noCredit", "No reset banked on Codex with ChatGPT Plus on spoo"],
      [spent("alreadyRedeemed"), "alreadyRedeemed", "That reset of Codex with ChatGPT Plus on spoo was already used"],
      [spent("resetPartly"), "unknown", "Codex answered resetPartly for Codex with ChatGPT Plus on spoo; the account was read again"],
    ];
    for (const [answer, outcome, said] of cases) {
      const h = harness({ reads: [reading(2)], spends: [answer] });
      expect(await h.reset({ account: KEY }), outcome).toEqual({ outcome, said, account: expect.objectContaining({ key: KEY }) });
    }
    const h = harness({ reads: [reading(2)], spends: [spent("reset", 1)] });
    await h.reset({ account: KEY, creditId: "rc_9" });
    expect(h.spendRuns()[0]!.script).toBe("SPEND key-1 rc_9");
    expect(h.filed.map(l => l.credits?.count)).toEqual([2, 1]);
  });

  it("joins a second press to the one in flight: one read, one spend, one key, the same answer", async () => {
    let release: (v: ResetSpend) => void = () => {};
    const held = new Promise<ResetSpend>(resolve => (release = resolve));
    const h = harness({ reads: [reading(2)], spends: [held as Promise<never>] });
    const first = h.reset({ account: KEY });
    const second = h.reset({ account: KEY });
    await new Promise(resolve => setTimeout(resolve, 10));
    release(spent("reset", 1));
    expect(await second).toEqual(await first);
    expect(h.runs.map(r => r.script)).toEqual(["READ /logins/pl_spoo/codex", "SPEND key-1 -"]);
  });

  it("keeps the key when the spend went unanswered, sends it again on the next press, and lets go once answered", async () => {
    const h = harness({ reads: [reading(2), reading(2)], spends: [{ answered: false }, spent("reset", 1)] });
    await expect(h.reset({ account: KEY })).rejects.toThrow("Codex on spoo did not answer; the same request goes again on the next press");
    expect(await h.store.get("usage-reset-pending", KEY)).toEqual({ key: "key-1", before: 2 });
    await h.reset({ account: KEY });
    expect(h.spendRuns().map(r => r.script)).toEqual(["SPEND key-1 -", "SPEND key-1 -"]);
    expect(await h.store.get("usage-reset-pending", KEY)).toBeUndefined();
  });

  it("keeps the key across a run that failed outright", async () => {
    const h = harness({ reads: [reading(2)], spends: [new Error("spoo is not answering")] });
    await expect(h.reset({ account: KEY })).rejects.toThrow("spoo is not answering");
    expect(await h.store.get("usage-reset-pending", KEY)).toEqual({ key: "key-1", before: 2 });
  });

  it("says the count fell since an unanswered press without claiming that press landed, lets go of its key and spends nothing", async () => {
    const h = harness({ reads: [reading(2), reading(1)], spends: [{ answered: false }] });
    await expect(h.reset({ account: KEY })).rejects.toThrow(/did not answer/);
    expect(await h.reset({ account: KEY })).toMatchObject({
      outcome: "earlier",
      said: "The count on Codex with ChatGPT Plus on spoo fell since the earlier press: it may have gone through, or a reset expired or was used elsewhere. Nothing more was spent; 1 left.",
    });
    // The second press read the account and sent no consume at all.
    expect(h.runs.map(r => r.script.split(" ")[0])).toEqual(["READ", "SPEND", "READ"]);
    expect(await h.store.get("usage-reset-pending", KEY)).toBeUndefined();
  });

  it("lets go of the key on a refusal, and says a build with no such request is too old", async () => {
    const h = harness({ reads: [reading(2), reading(2)], spends: [{ answered: true, refused: "Method not found", tooOld: true }, { answered: true, refused: "chatgpt authentication required", tooOld: false }] });
    await expect(h.reset({ account: KEY })).rejects.toThrow("Codex on spoo is older than 0.141 and has no resets");
    expect(await h.store.get("usage-reset-pending", KEY)).toBeUndefined();
    await expect(h.reset({ account: KEY })).rejects.toThrow("Codex on spoo refused the reset of Codex with ChatGPT Plus: chatgpt authentication required");
    expect(h.spendRuns().map(r => r.script)).toEqual(["SPEND key-1 -", "SPEND key-2 -"]);
  });
});
