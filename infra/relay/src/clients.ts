// SPDX-License-Identifier: AGPL-3.0-only
// The computers a person signed in from. A client token lists, deletes and
// adds the boxes on the account, so a copy of one that walked off has to be
// stoppable without rotating the key every box depends on: taking the row
// away is what kills the token, and its admissions go with it. An admission
// is bytes a computer already in signed for another computer's key; the relay
// keeps them for the boxes to verify and holds no key that could make one.
import { admissionOf, jsonBody } from "./body.js";
import { admissionsByClient, clientOf, clientsOf, deleteClient, insertAdmission, type ClientRow } from "./db.js";
import { clientFor } from "./hosts.js";
import { newId } from "./ids.js";
import type { Ctx } from "./index.js";
import { refuse } from "./refusal.js";

/** The listing wsp login prints: which computers hold a token for this account, which key each signed in with,
 * and who admitted each to the boxes. The signer is named where the account holds a computer under that key. */
export async function clientList(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const [rows, admissions] = await Promise.all([clientsOf(ctx.env, who.account), admissionsByClient(ctx.env, who.account)]);
  const named = new Map(rows.flatMap(row => (row.fingerprint === null ? [] : [[row.fingerprint, row.name] as const])));
  return Response.json({
    clients: rows.map(row => ({
      id: row.id,
      name: row.name,
      signedInAt: row.created_at,
      lastSeen: row.last_seen,
      thisOne: row.id === who.subject,
      fingerprint: row.fingerprint,
      admissions: (admissions.get(row.id) ?? []).map(a => {
        const byName = named.get(a.signer);
        return { by: a.signer, issuedAt: a.issued_at, ...(byName === undefined ? {} : { byName }) };
      }),
    })),
  });
}

/** The computer a request names, when it is on the bearer's own account. */
async function clientOn(ctx: Ctx, accountId: string): Promise<ClientRow> {
  const row = await clientOf(ctx.env, ctx.params["id"]!);
  if (row === undefined) throw refuse(404, "this relay holds no sign-in by that name");
  if (row.account_id !== accountId) throw refuse(403, "that sign-in is not on this account");
  return row;
}

export async function clientDelete(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const row = await clientOn(ctx, who.account);
  await deleteClient(ctx.env, row.id);
  return Response.json({ deleted: true });
}

/** An admission for a computer already on the account, which signed in on the page and was admitted by nobody, or
 * whose earlier admission a box no longer trusts. The relay holds the admission to the key that computer signed in
 * with and keeps the bytes; every box reads them off its next heartbeat and verifies them itself. */
export async function clientAdmit(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const row = await clientOn(ctx, who.account);
  const admission = admissionOf(await jsonBody(ctx));
  if (row.fingerprint === null) {
    throw refuse(400, `${row.name} signed in with no device key, so no box can admit it; sign it out with wsp logout ${row.id} and sign it in again with wsp login there`);
  }
  if (admission.device !== row.fingerprint) throw refuse(400, `that admission is for ${admission.device}, and ${row.name} signed in as ${row.fingerprint}`);
  await insertAdmission(ctx.env, {
    id: newId("m", ctx.deps.random),
    account_id: who.account,
    client_id: row.id,
    signer: admission.by,
    issued_at: admission.issuedAt,
    signature: admission.signature,
    created_at: new Date(ctx.deps.now()).toISOString(),
  });
  return Response.json({ recorded: true });
}
