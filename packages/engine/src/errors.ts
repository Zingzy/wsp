import { machineUnreachedLine } from "@wsp/protocol";

export type ErrorKind =
  | "concurrency" | "plan" | "missing" | "conflict"
  | "snapshotUnavailable" | "transient" | "auth" | "unknown";

export interface WspError { kind: ErrorKind; status: number; code?: string; message: string }

export function classify(status: number, body: { code?: string; error?: string }): WspError {
  const message = body.error ?? "";
  if (status === 429) return { kind: "concurrency", status, code: body.code, message };
  if (status === 401) return { kind: "auth", status, code: body.code, message };
  if (status === 402 || status === 403) return { kind: "plan", status, code: body.code, message };
  if (status === 404) return { kind: "missing", status, code: body.code, message };
  if (status === 409) return { kind: "conflict", status, code: body.code, message };
  // PoC finding: deterministic snapshot failure wears a transient status code.
  if (status === 502 && message === "Failed to snapshot sandbox")
    return { kind: "snapshotUnavailable", status, code: body.code, message };
  if (status >= 502 && status <= 504) return { kind: "transient", status, code: body.code, message };
  return { kind: "unknown", status, code: body.code, message };
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
