// SPDX-License-Identifier: AGPL-3.0-only
// wsp usage reset against a host that answers the two ops it sends: the accounts it names one from, and the spend.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, noSuchAccountLine, resetQuestion, type AccountRow, type ResetAnswer } from "@wsp/protocol";
import type { CliIO } from "../src/cli.js";
import { runVerb, VERBS, type CliOnlyVerb, type HostClient } from "../src/verbs.js";

const ROWS: AccountRow[] = [
  { key: "codex:acct_a", agent: "codex", label: "Codex with ChatGPT Plus", address: "a@example.com", computers: ["spoo"], credits: { count: 2, readAt: 1 } },
  { key: "codex:acct_b", agent: "codex", label: "Codex with ChatGPT Pro", address: "b@example.com", computers: ["Boat"], credits: { count: 1, readAt: 1 } },
  { key: "codex:acct_c", agent: "codex", label: "Codex with ChatGPT Pro", address: "c@example.com", computers: ["Boat"] },
];
const ANSWER: ResetAnswer = { outcome: "reset", said: "Reset used: Codex with ChatGPT Plus on spoo's windows start again now, 1 left", account: ROWS[0]! };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The verb run against a host answering the accounts and a spend, with what it asked, said and was sent. */
async function reset(argv: string[], o: { tty?: boolean; answer?: string; refuse?: Error } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wsp-usage-reset-"));
  dirs.push(dir);
  const sent: { op: string; params?: Record<string, unknown> }[] = [];
  const asked: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const client = {
    request: async (op: string, params?: Record<string, unknown>) => {
      sent.push({ op, ...(params !== undefined ? { params } : {}) });
      if (op === "usage.accounts") return { accounts: ROWS };
      if (o.refuse !== undefined) throw o.refuse;
      return ANSWER;
    },
    close: () => {},
  } as unknown as HostClient;
  const io: CliIO = {
    log: line => lines.push(line),
    error: line => errors.push(line),
    ask: async question => (asked.push(question), o.answer ?? "yes"),
    askSecret: () => Promise.reject(new Error("no prompt")),
    ...(o.tty === true ? { isTTY: true } : {}),
  };
  const verb = VERBS.find((v): v is CliOnlyVerb => v.name === "usage reset" && "cliOnly" in v)!;
  const code = await runVerb(verb, ["usage", "reset", ...argv], io, () => join(dir, "state.json"), { env: {}, dial: async () => client });
  return { code, sent, asked, lines, errors, spends: sent.filter(s => s.op === "usage.reset") };
}

describe("wsp usage reset", () => {
  it("names the account by its key, its label or its address, asks first on a terminal, and spends on yes", async () => {
    for (const word of ["codex:acct_a", "codex with chatgpt plus", "A@example.com"]) {
      const run = await reset([word, "--credit", "rc_1", "--on", "spoo"], { tty: true });
      expect(run.code, word).toBe(0);
      expect(run.asked).toEqual([resetQuestion("Codex with ChatGPT Plus", 2)]);
      expect(run.spends).toEqual([{ op: "usage.reset", params: { account: "codex:acct_a", creditId: "rc_1", on: "spoo" } }]);
      expect(run.lines).toEqual([ANSWER.said]);
    }
  });

  it("spends nothing on any answer but yes", async () => {
    const run = await reset(["codex:acct_a"], { tty: true, answer: "no" });
    expect(run.code).toBe(1);
    expect(run.spends).toEqual([]);
    expect(run.errors).toEqual(["Every reset banked on Codex with ChatGPT Plus kept"]);
  });

  it("is refused off a terminal without --yes, and spends with it, the answer as JSON under --json", async () => {
    const off = await reset(["codex:acct_a", "--json"]);
    expect(off.code).toBe(EXIT_CODES.usage);
    expect(off.spends).toEqual([]);
    expect(JSON.parse(off.errors[0]!)).toEqual({ error: `${resetQuestion("Codex with ChatGPT Plus", 2).split("\n")[0]} There is no terminal to answer on. Pass --yes to say yes.`, class: "usage", exit: 3 });
    const yes = await reset(["codex:acct_a", "--yes", "--json"]);
    expect(yes.code).toBe(0);
    expect(JSON.parse(yes.lines.at(-1)!)).toEqual(ANSWER);
  });

  it("refuses an account nothing names, and a label two accounts share, naming their keys", async () => {
    const none = await reset(["nope", "--yes"]);
    expect(none.code).toBe(EXIT_CODES.usage);
    expect(none.errors[0]).toContain(noSuchAccountLine("nope"));
    const two = await reset(["Codex with ChatGPT Pro", "--yes"]);
    expect(two.code).toBe(EXIT_CODES.usage);
    expect(two.errors[0]).toContain("codex:acct_b and codex:acct_c");
    expect([...none.spends, ...two.spends]).toEqual([]);
  });

  it("exits by the class the host stamped its refusal with", async () => {
    const keyed = await reset(["codex:acct_a", "--yes"], { refuse: Object.assign(new Error("Codex with an API key pays per token; an API key has no reset to use"), { kind: "usage" }) });
    expect(keyed.code).toBe(EXIT_CODES.usage);
    const silent = await reset(["codex:acct_a", "--yes"], { refuse: new Error("Codex on spoo did not answer; the same request goes again on the next press") });
    expect(silent.code).toBe(EXIT_CODES.provider);
  });

  it("takes one account", async () => {
    expect((await reset([])).code).toBe(EXIT_CODES.usage);
    expect((await reset(["a", "b"])).code).toBe(EXIT_CODES.usage);
  });
});
