// SPDX-License-Identifier: AGPL-3.0-only
// A Codex plan's banked resets, read and spent through `codex app-server`
// outside any turn, on the computer the login lives on, as codex-cli 0.155.1's
// schema spells the requests. The read asks the sign-in and the limits with
// each reset in full; the spend consumes one under the caller's idempotency key
// and reads the limits again only once the consume answered, so the reading is
// the one the reset left. The count landed in 0.141, the details in 0.143.
import { programWord, shellQuote, type HarnessLimit, type PlanResets, type ResetReading, type ResetRoad, type ResetSpend } from "@wsp/protocol";
import { creditsOf, limitOf, snapshotOf } from "./adapter.js";
import { answersOf, appServerScript, initializeRequest, notification, request, resultOf, type ServerAnswer } from "./app-server-script.js";
import { buildEnv, slug } from "./command.js";

const INIT = 1;
const ACCOUNT = 2;
const LIMITS = 3;
const CONSUME = 4;
const METHOD_NOT_FOUND = -32601;

const OPEN = [initializeRequest(INIT), notification("initialized")];
const LIMITS_READ = request(LIMITS, "account/rateLimits/read");

/** `cd ~` and the exports first: the exec a computer runs this under carries no environment of its own. */
function script(road: ResetRoad, stages: Parameters<typeof appServerScript>[1]): string {
  const codex = programWord("codex", road.launch);
  const exports = Object.entries(buildEnv({ base: road.env, home: road.home }))
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  return `cd ~ && export ${exports}\n${appServerScript(codex, stages)}`;
}

export function resetReadCommand(road: ResetRoad): string {
  return script(road, [{ lines: [...OPEN, request(ACCOUNT, "account/read"), LIMITS_READ], answers: 3 }]);
}

export function resetCreditCommand(road: ResetRoad & { idempotencyKey: string; creditId?: string }): string {
  const params = { idempotencyKey: slug("idempotencyKey", road.idempotencyKey), ...(road.creditId !== undefined ? { creditId: slug("creditId", road.creditId) } : {}) };
  return script(road, [
    { lines: [...OPEN, request(CONSUME, "account/rateLimitResetCredit/consume", params)], answers: 2 },
    { lines: [LIMITS_READ], answers: 1 },
  ]);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The limits answer as a reading, with the sign-in account/read named where it was asked. */
function limitIn(answers: ReadonlyMap<number, ServerAnswer>, signIn?: Record<string, unknown>): HarnessLimit | undefined {
  const answer = resultOf(answers, LIMITS);
  if (answer === undefined) return undefined;
  const email = str(signIn?.["email"]);
  const plan = str(signIn?.["planType"]);
  const id = str(answer["accountId"]) ?? email;
  const account = { ...(id !== undefined ? { id } : {}), ...(email !== undefined ? { label: email } : {}), ...(plan !== undefined ? { plan } : {}) };
  const credits = creditsOf(answer);
  return (
    limitOf(snapshotOf(answer) ?? {}, account, credits) ?? {
      windows: [],
      ...(id !== undefined ? { account: { id, ...(email !== undefined ? { label: email } : {}) } } : {}),
      ...(credits !== undefined ? { credits } : {}),
    }
  );
}

/** Nothing where the server never answered initialize. */
export function parseResetRead(stdout: string): ResetReading | undefined {
  const answers = answersOf(stdout);
  if (!answers.has(INIT)) return undefined;
  const signIn = resultOf(answers, ACCOUNT)?.["account"];
  const account = typeof signIn === "object" && signIn !== null ? (signIn as Record<string, unknown>) : undefined;
  if (account?.["type"] === "apiKey") return { keyed: true };
  const limit = limitIn(answers, account);
  return { keyed: false, ...(limit !== undefined ? { limit } : {}) };
}

export function parseResetCredit(stdout: string): ResetSpend {
  const answers = answersOf(stdout);
  const consumed = answers.get(CONSUME);
  if (consumed === undefined) return { answered: false };
  if ("error" in consumed) return { answered: true, refused: consumed.error.message, tooOld: consumed.error.code === METHOD_NOT_FOUND };
  const limit = limitIn(answers);
  return { answered: true, outcome: str(consumed.result["outcome"]) ?? "unknown", ...(limit !== undefined ? { limit } : {}) };
}

export const codexPlanResets: PlanResets = {
  readCommand: resetReadCommand,
  parseRead: parseResetRead,
  spendCommand: resetCreditCommand,
  parseSpend: parseResetCredit,
  tooOld: "is older than 0.141 and has no resets",
};
