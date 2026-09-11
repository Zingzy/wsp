// SPDX-License-Identifier: AGPL-3.0-only
// Every statement the relay runs, in one place, so what it keeps can be read
// off one file and held to the migration beside it.
import type { Env } from "./env.js";

export interface AccountRow {
  id: string;
  provider: string;
  provider_id: string;
  login: string;
  created_at: string;
}

export interface HostRow {
  id: string;
  account_id: string;
  name: string;
  hostname: string | null;
  tunnel_id: string | null;
  connector_version: string | null;
  created_at: string;
  last_seen: string | null;
}

export type LinkState = "pending" | "approved";

export interface LinkRow {
  code: string;
  poll_hash: string;
  kind: "host" | "client";
  name: string;
  state: LinkState;
  account_id: string | null;
  host_id: string | null;
  created_at: string;
  expires_at: string;
}

export async function accountOf(env: Env, id: string): Promise<AccountRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>()) ?? undefined;
}

export async function accountByProvider(env: Env, provider: string, providerId: string): Promise<AccountRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM accounts WHERE provider = ? AND provider_id = ?").bind(provider, providerId).first<AccountRow>()) ?? undefined;
}

export async function insertAccount(env: Env, row: AccountRow): Promise<void> {
  await env.DB.prepare("INSERT INTO accounts (id, provider, provider_id, login, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.provider, row.provider_id, row.login, row.created_at)
    .run();
}

/** The login a person signs in under can change on their side; the account is the same one either way. */
export async function renameAccount(env: Env, id: string, login: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET login = ? WHERE id = ?").bind(login, id).run();
}

export async function hostOf(env: Env, id: string): Promise<HostRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>()) ?? undefined;
}

export async function hostsOf(env: Env, accountId: string): Promise<HostRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM hosts WHERE account_id = ? ORDER BY name").bind(accountId).all<HostRow>();
  return results;
}

/** Whether this account already holds a box under this name, which is what tells one of a person's boxes from another. */
export async function hostNamed(env: Env, accountId: string, name: string): Promise<HostRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM hosts WHERE account_id = ? AND name = ?").bind(accountId, name).first<HostRow>()) ?? undefined;
}

export async function insertHost(env: Env, row: Pick<HostRow, "id" | "account_id" | "name" | "created_at">): Promise<void> {
  await env.DB.prepare("INSERT INTO hosts (id, account_id, name, created_at) VALUES (?, ?, ?, ?)").bind(row.id, row.account_id, row.name, row.created_at).run();
}

export async function setHostTunnel(env: Env, id: string, tunnelId: string, hostname: string): Promise<void> {
  await env.DB.prepare("UPDATE hosts SET tunnel_id = ?, hostname = ? WHERE id = ?").bind(tunnelId, hostname, id).run();
}

export async function seenHost(env: Env, id: string, at: string, seen: { hostname?: string; version?: string }): Promise<void> {
  await env.DB.prepare("UPDATE hosts SET last_seen = ?, hostname = COALESCE(?, hostname), connector_version = COALESCE(?, connector_version) WHERE id = ?")
    .bind(at, seen.hostname ?? null, seen.version ?? null, id)
    .run();
}

export async function deleteHost(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM hosts WHERE id = ?").bind(id).run();
}

export async function insertLink(env: Env, row: LinkRow): Promise<void> {
  await env.DB.prepare("INSERT INTO link_codes (code, poll_hash, kind, name, state, account_id, host_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.code, row.poll_hash, row.kind, row.name, row.state, row.account_id, row.host_id, row.created_at, row.expires_at)
    .run();
}

export async function linkByCode(env: Env, code: string): Promise<LinkRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first<LinkRow>()) ?? undefined;
}

export async function linkByPoll(env: Env, pollHash: string): Promise<LinkRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM link_codes WHERE poll_hash = ?").bind(pollHash).first<LinkRow>()) ?? undefined;
}

/** Approval is the one write that turns a pending code into a token waiting to be collected, and it happens once:
 * the update names the state it expects, so two browsers racing on one code make one host between them. */
export async function approveLink(env: Env, code: string, accountId: string, hostId: string | null): Promise<boolean> {
  const { meta } = await env.DB.prepare("UPDATE link_codes SET state = 'approved', account_id = ?, host_id = ? WHERE code = ? AND state = 'pending'")
    .bind(accountId, hostId, code)
    .run();
  return (meta.changes ?? 0) > 0;
}

export async function deleteLink(env: Env, code: string): Promise<void> {
  await env.DB.prepare("DELETE FROM link_codes WHERE code = ?").bind(code).run();
}
