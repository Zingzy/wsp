// SPDX-License-Identifier: AGPL-3.0-only
// The computers a person signed in from. A client token lists and deletes
// every box on the account, so a copy of one that walked off has to be
// stoppable without rotating the key every box depends on: taking the row
// away is what kills the token.
import { clientOf, clientsOf, deleteClient } from "./db.js";
import { clientFor } from "./hosts.js";
import type { Ctx } from "./index.js";
import { refuse } from "./refusal.js";

export async function clientList(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const rows = await clientsOf(ctx.env, who.account);
  return Response.json({
    clients: rows.map(row => ({ id: row.id, name: row.name, signedInAt: row.created_at, lastSeen: row.last_seen, thisOne: row.id === who.subject })),
  });
}

export async function clientDelete(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const id = ctx.params["id"]!;
  const row = await clientOf(ctx.env, id);
  if (row === undefined) throw refuse(404, "this relay holds no sign-in by that name");
  if (row.account_id !== who.account) throw refuse(403, "that sign-in is not on this account");
  await deleteClient(ctx.env, id);
  return Response.json({ deleted: true });
}
