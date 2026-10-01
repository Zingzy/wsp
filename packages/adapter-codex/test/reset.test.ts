// SPDX-License-Identifier: AGPL-3.0-only
// The two scripts a banked reset is read and spent by, run under bash against a fake `codex app-server` that answers
// each request a beat after it reads it and exits the moment its stdin closes, dropping whatever it had not answered
// yet, as the real one does: a script that let go of stdin early would lose its answers here too.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStub } from "../../protocol/test/stub-script.js";
import { codexPlanResets, parseResetCredit, parseResetRead, resetCreditCommand, resetReadCommand } from "../src/reset.js";

type Json = Record<string, unknown>;

const FAKE = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const home = process.env.CODEX_HOME;
if (process.argv[2] !== "app-server") process.exit(2);
const answers = JSON.parse(fs.readFileSync(path.join(home, "answers.json"), "utf8"));
let sent = 0;
let buf = "";
const log = m => fs.appendFileSync(path.join(home, "requests.log"), JSON.stringify({ after: sent, ...m }) + "\\n");
const handle = line => {
  const m = JSON.parse(line);
  log(m);
  if (m.id === undefined) return;
  const a = answers[m.method];
  if (a === "exit") process.exit(0);
  if (a === "silent") return;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ id: m.id, ...(a ?? { result: {} }) }) + "\\n");
    sent++;
  }, 30);
};
process.stdin.on("data", d => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    handle(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A CODEX_HOME holding the fake's answers by method, and a bin folder with the fake as codex. */
function fake(answers: Json): { home: string; path: string; requests: () => Json[] } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-codex-reset-"));
  dirs.push(dir);
  const home = join(dir, "codex-home");
  const bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeStub(join(bin, "codex"), FAKE);
  writeFileSync(join(home, "answers.json"), JSON.stringify(answers));
  const requests = (): Json[] =>
    readFileSync(join(home, "requests.log"), "utf8")
      .split("\n")
      .filter(l => l !== "")
      .map(l => JSON.parse(l) as Json);
  return { home, path: `${bin}:/usr/bin:/bin`, requests };
}

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
