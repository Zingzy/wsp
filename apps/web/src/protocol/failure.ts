// SPDX-License-Identifier: AGPL-3.0-only
import { refusalSaid } from "@wsp/protocol";
import { DisconnectedError, NO_REASON } from "./client.js";

/** A failure as the app shows it: what happened, what to do about it when the host said, the kind it was stamped
 * with, and whether no socket carried the request at all. */
export interface Failure {
  said: string;
  fix: string | undefined;
  kind: string | undefined;
  disconnected: boolean;
}

const stringProp = (e: object, key: "fix" | "kind"): string | undefined => {
  const v = (e as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

/** Reads any rejection into a Failure. The host joins the two halves into one sentence for a terminal, so `said` is
 * that sentence with its fix taken back off the end. */
export function failureOf(e: unknown): Failure {
  if (!(e instanceof Error)) return { said: e == null ? NO_REASON : String(e), fix: undefined, kind: undefined, disconnected: false };
  const fix = stringProp(e, "fix");
  return { said: refusalSaid(e.message, fix), fix, kind: stringProp(e, "kind"), disconnected: e instanceof DisconnectedError };
}
