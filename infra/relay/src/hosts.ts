// SPDX-License-Identifier: AGPL-3.0-only
// What a linked box and a person's own client ask of the relay: a tunnel to
// sit behind, a heartbeat saying where it landed, the listing that tells a
// client where a box answers, and the delete that takes a box off the
// account. A host token names one box; a client token names a person.
import { createCname, createTunnel, deleteCname, deleteTunnel, setIngress, tunnelToken } from "./cloudflare.js";
import { deleteHost, hostOf, hostsOf, seenHost, setHostTunnel, type HostRow } from "./db.js";
import { NO_ZONE_LINE, zoneOf } from "./env.js";
import type { Ctx } from "./index.js";
import { refuse } from "./refusal.js";
import { readToken, type TokenClaims } from "./tokens.js";

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

/** The person a client token names, refusing a box's own token: a host stands for one machine, not for whoever owns it. */
async function clientFor(ctx: Ctx): Promise<TokenClaims> {
  const claims = await claimsOf(ctx);
  if (claims.kind !== "client") throw refuse(403, "that is a host's own token; this route is for the token wsp relay hosts holds on a person's computer");
  return claims;
}

/** The tunnel a box sits behind. With no zone the relay makes nothing at all, and the box runs a quick tunnel instead. */
export async function hostTunnel(ctx: Ctx): Promise<Response> {
  const row = await hostFor(ctx);
  const body = (await ctx.req.json().catch(() => ({}))) as { port?: unknown };
  const port = typeof body.port === "number" && Number.isInteger(body.port) && body.port > 0 && body.port < 65_536 ? body.port : undefined;
  if (port === undefined) throw refuse(400, "a tunnel needs the port on the box this relay's traffic is carried to");
  const zone = zoneOf(ctx.env);
  if (zone === undefined) return Response.json({ tunnelToken: null, hostname: null, why: NO_ZONE_LINE });
  // A managed name is the host's id under the zone and nothing else: what the row holds may be the quick tunnel's
  // own name from a run when this relay had no zone, which is not a name to point at anything.
  const hostname = `${row.id}.${zone.zone}`;
  const tunnelId = row.tunnel_id ?? (await createTunnel(ctx.env, ctx.deps, `wsp-${row.id}`));
  // The box may serve on another port than it did last time, so what the tunnel carries to is written every time.
  await setIngress(ctx.env, ctx.deps, tunnelId, hostname, port);
  if (row.hostname !== hostname) {
    await createCname(ctx.env, ctx.deps, zone, hostname, tunnelId);
    await setHostTunnel(ctx.env, row.id, tunnelId, hostname);
  }
  return Response.json({ tunnelToken: await tunnelToken(ctx.env, ctx.deps, tunnelId), hostname });
}

export async function hostHeartbeat(ctx: Ctx): Promise<Response> {
  const row = await hostFor(ctx);
  const body = (await ctx.req.json().catch(() => ({}))) as { hostname?: unknown; version?: unknown };
  await seenHost(ctx.env, row.id, new Date(ctx.deps.now()).toISOString(), {
    ...(typeof body.hostname === "string" && body.hostname !== "" ? { hostname: body.hostname } : {}),
    ...(typeof body.version === "string" && body.version !== "" ? { version: body.version } : {}),
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

/** Taking a box off the account: the tunnel and the name under the zone go with it, so nothing is left billing or resolving. */
export async function hostDelete(ctx: Ctx): Promise<Response> {
  const claims = await claimsOf(ctx);
  const id = ctx.params["id"]!;
  const row = await hostOf(ctx.env, id);
  if (row === undefined) throw refuse(404, "this relay holds no host by that name");
  const ownsIt = claims.kind === "client" ? row.account_id === claims.account : claims.subject === id && row.account_id === claims.account;
  if (!ownsIt) throw refuse(403, "that token does not name this host");
  const zone = zoneOf(ctx.env);
  if (row.tunnel_id !== null) {
    if (zone !== undefined && row.hostname !== null && row.hostname.endsWith(`.${zone.zone}`)) await deleteCname(ctx.env, ctx.deps, zone, row.hostname);
    await deleteTunnel(ctx.env, ctx.deps, row.tunnel_id);
  }
  await deleteHost(ctx.env, id);
  return Response.json({ deleted: true });
}
