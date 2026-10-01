// SPDX-License-Identifier: AGPL-3.0-only
// The two scripts a banked reset is read and spent by, run under bash against a fake `codex app-server` that exits
// on stdin EOF as the real one does.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAppServer, type Json } from "./fake-app-server.js";
import { codexPlanResets, parseResetCredit, parseResetRead, resetCreditCommand, resetReadCommand } from "../src/reset.js";

const made: (() => void)[] = [];
afterEach(() => made.splice(0).forEach(remove => remove()));
const fake = (answers: Json) => {
  const f = fakeAppServer(answers);
  made.push(f.remove);
  return f;
};

const run = (script: string): string => execFileSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } });

const chatgpt = { result: { account: { type: "chatgpt", email: "dev@example.com", planType: "plus" }, requiresOpenaiAuth: true } };
const snapshot = (used: number) => ({ limitId: "codex", primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1_790_700_000 }, secondary: null, planType: "plus", rateLimitReachedType: null });
const limits = (used: number, availableCount: number, credits: Json[] | null) => ({
  result: { rateLimits: snapshot(used), rateLimitsByLimitId: { codex: snapshot(used) }, accountId: "acct_7f3a", rateLimitResetCredits: { availableCount, credits } },
});
const credit = (id: string, expiresAt: number) => ({ id, resetType: "codexRateLimits", status: "available", grantedAt: 1_790_000_000, expiresAt, title: null, description: null });

describe("reading the banked resets", () => {
  it("asks the sign-in and the limits in full under the login's own home and PATH, and reads the account, the windows and each reset", () => {
    const f = fake({ "account/read": chatgpt, "account/rateLimits/read": limits(80, 2, [credit("rc_1", 1_792_000_000), credit("rc_2", 1_793_000_000)]) });
    const script = resetReadCommand({ home: f.home, env: { PATH: f.path } });
    expect(script).toContain(`CODEX_HOME='${f.home}'`);
    const read = parseResetRead(run(script));
    expect(f.requests().map(r => [r["method"], r["params"]])).toEqual([
      ["initialize", { clientInfo: { name: "wsp", version: "0" } }],
      ["initialized", {}],
      ["account/read", {}],
      ["account/rateLimits/read", {}],
    ]);
    expect(read).toEqual({
      keyed: false,
      limit: {
        windows: [{ kind: "session", usedPercent: 80, resetsAt: 1_790_700_000_000 }],
        plan: "plus",
        status: "ok",
        account: { id: "acct_7f3a", label: "dev@example.com" },
        credits: {
          count: 2,
          credits: [
            { id: "rc_1", status: "available", expiresAt: 1_792_000_000_000 },
            { id: "rc_2", status: "available", expiresAt: 1_793_000_000_000 },
          ],
        },
      },
    });
  });

  it("reads a sign-in by API key as keyed, which has no reset to spend", () => {
    const f = fake({ "account/read": { result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }, "account/rateLimits/read": { error: { code: -32600, message: "chatgpt authentication required" } } });
    expect(parseResetRead(run(resetReadCommand({ home: f.home, env: { PATH: f.path } })))).toEqual({ keyed: true });
  });

  it("reads nothing where the server never answered", () => {
    expect(parseResetRead("bash: codex: command not found\n")).toBeUndefined();
  });

  it("refuses a relative home, as the turn env does", () => {
    expect(() => resetReadCommand({ home: ".codex" })).toThrow(/absolute/);
  });
});

describe("spending one", () => {
  it("consumes under the caller's key and the credit it named, reads the limits again only once the consume answered, and reads both", () => {
    const f = fake({ "account/rateLimitResetCredit/consume": { result: { outcome: "reset" } }, "account/rateLimits/read": limits(0, 1, [credit("rc_2", 1_793_000_000)]) });
    const out = run(resetCreditCommand({ home: f.home, env: { PATH: f.path }, idempotencyKey: "0b6f7d2e-5f1c-4f43-9a51-2c8e1f0e9a11", creditId: "rc_1" }));
    const asked = f.requests();
    expect(asked.map(r => r["method"])).toEqual(["initialize", "initialized", "account/rateLimitResetCredit/consume", "account/rateLimits/read"]);
    expect(asked[2]!["params"]).toEqual({ idempotencyKey: "0b6f7d2e-5f1c-4f43-9a51-2c8e1f0e9a11", creditId: "rc_1" });
    // The read went only after the consume's answer, so it reads the windows the reset left.
    expect(asked[3]!["after"]).toBe(2);
    expect(asked[3]!["params"]).toEqual({});
    const spent = parseResetCredit(out);
    expect(spent).toMatchObject({ answered: true, outcome: "reset", limit: { windows: [{ kind: "session", usedPercent: 0, resetsAt: 1_790_700_000_000 }], credits: { count: 1 } } });
  });

  it("leaves the credit to the backend's pick where none is named", () => {
    const f = fake({ "account/rateLimitResetCredit/consume": { result: { outcome: "nothingToReset" } }, "account/rateLimits/read": limits(10, 2, null) });
    expect(parseResetCredit(run(resetCreditCommand({ home: f.home, env: { PATH: f.path }, idempotencyKey: "k-1" })))).toMatchObject({ answered: true, outcome: "nothingToReset" });
    expect(f.requests()[2]!["params"]).toEqual({ idempotencyKey: "k-1" });
  });

  it("hands every outcome on as Codex said it, one it does not know included", () => {
    for (const outcome of ["noCredit", "alreadyRedeemed", "resetPartly"]) {
      const f = fake({ "account/rateLimitResetCredit/consume": { result: { outcome } } });
      expect(parseResetCredit(run(resetCreditCommand({ home: f.home, env: { PATH: f.path }, idempotencyKey: "k-1" }))), outcome).toMatchObject({ answered: true, outcome });
    }
  });

  it("reads a server that has no such method as one too old for resets, and any other refusal in its own words", () => {
    const missing = fake({ "account/rateLimitResetCredit/consume": { error: { code: -32601, message: "Method not found" } } });
    expect(parseResetCredit(run(resetCreditCommand({ home: missing.home, env: { PATH: missing.path }, idempotencyKey: "k-1" })))).toEqual({ answered: true, refused: "Method not found", tooOld: true });
    const refused = fake({ "account/rateLimitResetCredit/consume": { error: { code: -32600, message: "chatgpt authentication required" } } });
    expect(parseResetCredit(run(resetCreditCommand({ home: refused.home, env: { PATH: refused.path }, idempotencyKey: "k-1" })))).toEqual({ answered: true, refused: "chatgpt authentication required", tooOld: false });
  });

  it("says the consume went unanswered where the server died before answering it, and sends no read after it", () => {
    const f = fake({ "account/rateLimitResetCredit/consume": "exit" });
    expect(parseResetCredit(run(resetCreditCommand({ home: f.home, env: { PATH: f.path }, idempotencyKey: "k-1" })))).toEqual({ answered: false });
    expect(f.requests().map(r => r["method"])).not.toContain("account/rateLimits/read");
  });

  it("refuses a credit id or a key that is not one plain word before it reaches the shell", () => {
    expect(() => resetCreditCommand({ home: "/root/.codex", idempotencyKey: "k-1", creditId: "rc'1" })).toThrow(/plain slug/);
    expect(() => resetCreditCommand({ home: "/root/.codex", idempotencyKey: "k 1" })).toThrow(/plain slug/);
  });

  it("kills only the pid the shell recorded for the server, and waits on no clock", () => {
    for (const script of [resetReadCommand({ home: "/root/.codex" }), resetCreditCommand({ home: "/root/.codex", idempotencyKey: "k-1" })]) {
      expect(script).toContain('kill "$WSP_APP_SERVER_PID"');
      expect(script).not.toMatch(/pkill|killall|kill -|kill "?0|\bsleep\b|\bcoproc\b/);
    }
  });

  it("is the agent's one registered set of reset roads", () => {
    expect(codexPlanResets.readCommand).toBe(resetReadCommand);
    expect(codexPlanResets.spendCommand).toBe(resetCreditCommand);
    expect(codexPlanResets.tooOld).toMatch(/older than 0\.141/);
  });
});
