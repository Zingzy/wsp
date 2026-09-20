// SPDX-License-Identifier: AGPL-3.0-only
// One reading of a request body for every route: a cap, a refusal a person can
// read, and no route left deciding for itself what a malformed body means.
import type { Ctx } from "./index.js";
import { refuse } from "./refusal.js";

/** Nothing this relay takes is larger than a name and a token; a body past this is refused unread. */
const BODY_MAX = 4096;

const TOO_LARGE = "that request body is larger than anything this route takes";

/** Every body this relay reads, the cap in front of the reading rather than behind it: a length the caller
 * declares past the cap is refused before a byte is asked for, and a body that declares none is refused at the
 * first byte past it, so what this Worker holds in memory is bounded whatever the caller says. */
export async function bodyText(ctx: Ctx): Promise<string> {
  if (Number(ctx.req.headers.get("content-length") ?? "") > BODY_MAX) throw refuse(413, TOO_LARGE);
  const body = ctx.req.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true || value === undefined) break;
    read += value.byteLength;
    if (read > BODY_MAX) {
      await reader.cancel();
      throw refuse(413, TOO_LARGE);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function jsonBody(ctx: Ctx): Promise<Record<string, unknown>> {
  const raw = await bodyText(ctx);
  try {
    const parsed: unknown = JSON.parse(raw === "" ? "{}" : raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw refuse(400, "that request body is not JSON");
  }
}
