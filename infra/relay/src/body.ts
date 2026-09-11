// SPDX-License-Identifier: AGPL-3.0-only
// One reading of a request body for every route: a cap, a refusal a person can
// read, and no route left deciding for itself what a malformed body means.
import type { Ctx } from "./index.js";
import { refuse } from "./refusal.js";

/** Nothing this relay takes is larger than a name and a token; a body past this is refused unread. */
const BODY_MAX = 4096;

export async function jsonBody(ctx: Ctx): Promise<Record<string, unknown>> {
  const raw = await ctx.req.text();
  if (raw.length > BODY_MAX) throw refuse(413, "that request body is larger than anything this route takes");
  try {
    const parsed: unknown = JSON.parse(raw === "" ? "{}" : raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw refuse(400, "that request body is not JSON");
  }
}
