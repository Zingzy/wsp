import { machineUnreachedLine } from "@wsp/protocol";

export type ErrorKind =
  | "concurrency" | "plan" | "missing" | "conflict"
  | "snapshotUnavailable" | "transient" | "auth" | "unknown";

/** requestId is the id the provider's reply carried, when it carried one: what a report to the provider quotes. */
export interface WspError { kind: ErrorKind; status: number; code?: string; message: string; requestId?: string }

export function classify(status: number, body: { code?: string; error?: string }, requestId?: string): WspError {
  const message = body.error ?? "";
  const rest = { status, code: body.code, message, ...(requestId !== undefined ? { requestId } : {}) };
  if (status === 429) return { kind: "concurrency", ...rest };
  if (status === 401) return { kind: "auth", ...rest };
  if (status === 402 || status === 403) return { kind: "plan", ...rest };
  if (status === 404) return { kind: "missing", ...rest };
  if (status === 409) return { kind: "conflict", ...rest };
  // Not retried here: the seal retries this answer on its own clock while the builder still reads running.
  if (status === 502 && message === "Failed to snapshot sandbox")
    return { kind: "snapshotUnavailable", ...rest };
  if (status >= 502 && status <= 504) return { kind: "transient", ...rest };
  return { kind: "unknown", ...rest };
}

/** What a backend's pause ends with when the provider never answered the move (a missed budget, a call the network
 * dropped) and the machine did not land where the move leaves it, carrying the last such failure as its cause; a
 * refusal the provider answered with is thrown as itself. */
export class MoveUnansweredError extends Error {}

/** What a backend's resume ends with when the provider never took the call inside its cap and the machine still
 * reads paused: the one failure the host answers by asking again on its own rather than by handing the row back to
 * the person. */
export class ResumeUnansweredError extends MoveUnansweredError {}

/** Thrown by a backend that refuses a snapshot of a machine that has been resumed. Typed so callers (the wizard) can
 * tell "start over" from an ordinary failure. */
export class NotFirstLifeError extends Error {
  readonly kind = "notFirstLife" as const;
  constructor(
    readonly machineId: string,
    action: string,
  ) {
    super(`${action} refused: machine ${machineId} is not first-life (it was resumed); snapshots only come from fresh machines`);
    this.name = "NotFirstLifeError";
  }
}

/** The provider answered 404 for the machine: it no longer knows it. */
export function isMissing(e: unknown): boolean {
  return (e as WspError | undefined)?.kind === "missing";
}

export function shouldRetry(e: WspError, attempt: number): boolean {
  return e.kind === "transient" && attempt < 3;
}

export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

/** The failures of a call nothing answered. Node's fetch says "fetch failed" and hangs the socket or DNS error
 * underneath; a body cut mid-read carries the socket's code itself. A gateway status is an answer the backend already
 * retried on its own, and a missing machine, a refused command or a bad token all answered: none of those are here. */
const NETWORK_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const codeOf = (e: unknown): string | undefined => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined);

export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message === "fetch failed" || NETWORK_CODES.has(codeOf(e) ?? "") || NETWORK_CODES.has(codeOf(e.cause) ?? "");
}

/** Whether the call was cut off by the cap its caller gave it rather than answered or refused by the far end. The
 * name is fetch's own for an AbortSignal.timeout; DOMException carries it and is an Error here, but the check reads
 * the name off any object so a fetch a test stands in for needs no DOMException of its own. */
export function isCapped(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "TimeoutError";
}

/** The system errors under a failed fetch that mean this computer has no road out: the name would not resolve, or
 * there is no route to anything. A refused or reset connection and a timeout are the far end's and stay the
 * machine's miss (a dropped edge request is how the poll finds a machine gone). */
const OFFLINE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN"]);

/** The code of the road that failed, or undefined when the failure was not this computer's road. fetch rejects with
 * TypeError "fetch failed" for every failure under HTTP and puts the system error, or an AggregateError of one per
 * address tried, in its cause. */
export function roadCode(e: unknown): string | undefined {
  if (!(e instanceof TypeError) || e.message !== "fetch failed") return undefined;
  const cause = e.cause as { code?: unknown; errors?: unknown } | undefined;
  const codes = Array.isArray(cause?.errors) ? cause.errors.map(err => (err as { code?: unknown } | null)?.code) : [cause?.code];
  const named = codes.filter((code): code is string => typeof code === "string" && OFFLINE_CODES.has(code));
  return codes.length > 0 && named.length === codes.length ? named[0] : undefined;
}

/** Whether the request failed before it left this computer. The reach probe's word for a silence and the retry's
 * word for a road worth trying again are the same one. */
export function roadFailed(e: unknown): boolean {
  return roadCode(e) !== undefined;
}

/** How many times a call that never left this computer is sent, and the waits between the tries. This Mac's resolver
 * dropped one name for stretches while every other name answered, and answered it again inside the minute (measured
 * 2026-09-07); ten seconds of retry covers the flaps seen and still ends well inside the status poll's tick. */
export const ROAD_TRIES = 3;

export function roadBackoffMs(retry: number): number {
  return retry * 3_000 + Math.floor(Math.random() * 250);
}

/** How long a call to a machine keeps being retried when nothing answers: a DNS blip on this computer was measured
 * at about a minute, and a turn that waits half of it beats one that fails at once. */
export const REACH_WINDOW_MS = 30_000;

/** The error `untilReached` gives up with: the protocol's sentence, with the count and the time behind it. */
export class MachineUnreached extends Error {
  constructor(
    readonly attempts: number,
    readonly elapsedMs: number,
    cause: unknown,
  ) {
    super(machineUnreachedLine(attempts, elapsedMs), { cause });
  }
}

/** The clock a retry runs on; tests hand in one they move by hand. */
export interface RetryClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realRetryClock: RetryClock = { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)) };

/** Calls `once` until it answers. A network failure is retried at the engine's backoff for as long as the next wait
 * still ends inside the reach window, then the caller gets MachineUnreached; any other failure is rethrown at once. */
export async function untilReached<T>(once: () => Promise<T>, clock: RetryClock = realRetryClock): Promise<T> {
  const startedAt = clock.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await once();
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      const wait = backoffMs(attempt);
      if (clock.now() - startedAt + wait > REACH_WINDOW_MS) throw new MachineUnreached(attempt, clock.now() - startedAt, e);
      await clock.sleep(wait);
    }
  }
}
