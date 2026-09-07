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

export function shouldRetry(e: WspError, attempt: number): boolean {
  return e.kind === "transient" && attempt < 3;
}

export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}
