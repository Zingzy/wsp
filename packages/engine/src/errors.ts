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
