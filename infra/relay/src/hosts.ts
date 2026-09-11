// SPDX-License-Identifier: AGPL-3.0-only
// What a linked box and a person's own client ask of the relay: a tunnel to
// sit behind, a heartbeat saying where it landed, the listing that tells a
// client where a box answers, and the delete that takes a box off the
// account. A host token names one box; a client token names one computer a
// person signed in from. No name a box sends is ever a name this relay acts
// on: what it writes and deletes under its zone is derived from the host id.
import { jsonBody } from "./body.js";
import { createCname, createTunnel, deleteCname, deleteTunnel, setIngress, tunnelToken } from "./cloudflare.js";
import { clientOf, deleteHost, hostOf, hostsOf, seenClient, seenHost, setHostHostname, setHostTunnel, type HostRow } from "./db.js";
import { NO_ZONE_LINE, isQuickTunnel, managedHostname, zoneOf } from "./env.js";
import type { Ctx } from "./index.js";
import { refuse } from "./refusal.js";
import { readToken, type TokenClaims } from "./tokens.js";

/** A person's sign-in stands a month, and then that computer signs in again. A box's token does not run out: a box
 * nobody is sitting at cannot open a browser, and wsp relay unlink is how one is taken away. */
export const CLIENT_TOKEN_MS = 30 * 24 * 60 * 60_000;

/** The token a request carries, read from the one header it may ride in. A bearer never rides a URL, where a log would keep it. */
export async function claimsOf(ctx: Ctx): Promise<TokenClaims> {
  const carried = /^Bearer\s+(\S+)$/i.exec(ctx.req.headers.get("authorization") ?? "")?.[1];
  const claims = carried === undefined ? undefined : await readToken(ctx.env.RELAY_SIGNING_KEY, carried);
  if (claims === undefined) throw refuse(401, "this route needs the token the link gave this computer");
  return claims;
}

/** The box a request is about, when the token is that box's own and the relay still holds it. */
async function hostFor(ctx: Ctx): Promise<HostRow> {
  const claims = await claimsOf(ctx);
  const id = ctx.params["id"]!;
  const row = await hostOf(ctx.env, id);
  // A token for a host this relay no longer holds opens nothing: unlinking is how a box is taken away for good.
  if (claims.kind !== "host" || claims.subject !== id || row === undefined || row.account_id !== claims.account) {
    throw refuse(row === undefined || claims.kind !== "host" ? 401 : 403, "that token does not name this host");
  }
  return row;
}

/** The person a client token names: a box's own token is refused, a sign-in this account took away opens nothing,
 * and one older than a month has run out. The one reading of a client token, which every route that takes one
 * comes through, so a check cannot be spelled twice and drift. Callers that already read the bearer hand in what
 * they read rather than reading it again. */
export async function clientFor(ctx: Ctx, read?: TokenClaims): Promise<TokenClaims> {
  const claims = read ?? (await claimsOf(ctx));
  if (claims.kind !== "client") throw refuse(403, "that is a host's own token; this route is for the token wsp relay hosts holds on a person's computer");
  const row = await clientOf(ctx.env, claims.subject);
  if (row === undefined || row.account_id !== claims.account) throw refuse(401, "this computer's sign-in was taken away; run wsp relay hosts <url> to sign in again");
  if (ctx.deps.now() - claims.issuedAt > CLIENT_TOKEN_MS) throw refuse(401, "this computer's sign-in has run out; run wsp relay hosts <url> to sign in again");
  await seenClient(ctx.env, row.id, new Date(ctx.deps.now()).toISOString());
  return claims;
}

/** The tunnel a box sits behind. With no zone the relay makes nothing at all, and the box runs a quick tunnel instead. */
export async function hostTunnel(ctx: Ctx): Promise<Response> {
  const row = await hostFor(ctx);
  const body = await jsonBody(ctx);
  const asked = body["port"];
  const port = typeof asked === "number" && Number.isInteger(asked) && asked > 0 && asked < 65_536 ? asked : undefined;
  if (port === undefined) throw refuse(400, "a tunnel needs the port on the box this relay's traffic is carried to");
  const zone = zoneOf(ctx.env);
  if (zone === undefined) return Response.json({ tunnelToken: null, hostname: null, why: NO_ZONE_LINE });
  const hostname = managedHostname(row.id, zone);
  let tunnelId = row.tunnel_id;
  if (tunnelId === null) {
    tunnelId = await createTunnel(ctx.env, ctx.deps, `wsp-${row.id}`);
    // Written before anything else may fail: a tunnel no row points at is one nothing can delete through here.
    await setHostTunnel(ctx.env, row.id, tunnelId);
  }
  // The box may serve on another port than it did last time, so what the tunnel carries to is written every time.
  await setIngress(ctx.env, ctx.deps, tunnelId, hostname, port);
  if (row.hostname !== hostname) {
    await createCname(ctx.env, ctx.deps, zone, hostname, tunnelId);
    await setHostHostname(ctx.env, row.id, hostname);
  }
  return Response.json({ tunnelToken: await tunnelToken(ctx.env, ctx.deps, tunnelId), hostname });
}

/** A box saying it is there, and where a quick tunnel put it. The hostname is a line in a listing and nothing else:
 * a managed name is this relay's own to write, so a box may not send one and may not overwrite one. */
export async function hostHeartbeat(ctx: Ctx): Promise<Response> {
  const row = await hostFor(ctx);
  const body = await jsonBody(ctx);
  const said = body["hostname"];
  const hostname = typeof said === "string" && said !== "" ? said.toLowerCase() : undefined;
  if (hostname !== undefined && !isQuickTunnel(hostname)) {
    throw refuse(400, "a host may report the quick tunnel it was given and no other name; a managed hostname is the relay's own");
  }
  const version = typeof body["version"] === "string" && body["version"] !== "" ? body["version"] : undefined;
  const zone = zoneOf(ctx.env);
  // A box that has a managed name keeps it: what it reports about itself never replaces what this relay wrote.
  const managed = zone !== undefined && row.hostname === managedHostname(row.id, zone);
  await seenHost(ctx.env, row.id, new Date(ctx.deps.now()).toISOString(), {
    ...(hostname !== undefined && !managed ? { hostname } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  return Response.json({ ok: true });
}

/** One row per box on this person's account, and nobody else's. */
export async function hostList(ctx: Ctx): Promise<Response> {
  const claims = await clientFor(ctx);
  const rows = await hostsOf(ctx.env, claims.account);
  return Response.json({
    hosts: rows.map(row => ({
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      connectorVersion: row.connector_version,
      lastSeen: row.last_seen,
    })),
  });
}

/** Taking a box off the account: the tunnel and the name under the zone go with it, so nothing is left billing or
 * resolving. The name deleted is the one derived from the host id, never the one the box last reported. */
export async function hostDelete(ctx: Ctx): Promise<Response> {
  const claims = await claimsOf(ctx);
  const id = ctx.params["id"]!;
  const row = await hostOf(ctx.env, id);
  if (row === undefined) throw refuse(404, "this relay holds no host by that name");
  const ownsIt = claims.kind === "client" ? (await clientFor(ctx, claims)).account === row.account_id : claims.subject === id && row.account_id === claims.account;
  if (!ownsIt) throw refuse(403, "that token does not name this host");
  const zone = zoneOf(ctx.env);
  if (row.tunnel_id !== null) {
    if (zone !== undefined) await deleteCname(ctx.env, ctx.deps, zone, managedHostname(row.id, zone));
    await deleteTunnel(ctx.env, ctx.deps, row.tunnel_id);
  }
  await deleteHost(ctx.env, id);
  return Response.json({ deleted: true });
}
